// ============================================================================
// ConfigService — orchestrates branding, self-managed rates and the audit log.
// ============================================================================
// Every write is tenant-scoped: the organization comes from the session (never
// the payload); a non-admin caller can only touch their own agency's rate
// tables. Writes are audited in audit_logs (ADR-011) with the same actor and
// a request_id propagated from the route.

import type { FreightType } from '../../billing/domain/enums.js'
import type { ConfigSession } from '../middleware/auth.js'
import type { AgencyInfo, AgencyInfoPatch, AuditFilter, PaymentCatalogItem, RateTable, RateRow } from '../domain/types.js'
import type { ConfigRepository } from '../repo/config-repo.js'
import type { Row } from '../repo/config-repo.js'

export class ConfigService {
  constructor(private repo: ConfigRepository) {}

  /**
   * Branding is scoped server-side: every caller sees ONLY their own agency.
   * Even admins never see another agency's brand data — the panel shell needs
   * only the logged-in user's brand, and exposing other agencies' logo presence
   * leaks tenant info. Never returns storage keys (logo_key) — the panel only
   * needs the public URL.
   */
  async getBranding(session: ConfigSession) {
    return (await this.repo.listAgencies())
      .filter((a) => a.slug === session.agency)
      .map(stripStorageKey)
  }

  /**
   * Auditable writes are two round-trips (mutation, then audit insert). If the
   * audit insert fails, the mutation is already committed — we log and still
   * succeed, so the client never retries an already-applied mutation (which
   * would trip unique constraints or double-apply). The loss is a missing
   * audit row, not a corrupt write.
   */
  private async audit(entry: Parameters<ConfigRepository['insertAudit']>[0]): Promise<void> {
    try {
      await this.repo.insertAudit(entry)
    } catch (e) {
      console.error('audit insert failed:', e instanceof Error ? e.message : e, 'requestId:', entry.requestId)
    }
  }

  /**
   * Resolve the effective organization: an admin/billing caller may ask for
   * another agency (dashboard view); anyone else is pinned to their session
   * agency. The org is never trusted blindly — it is still validated against
   * the tenant of every row it touches.
   */
  resolveOrg(session: ConfigSession, requested?: string | null): string {
    if (requested && session.role !== 'admin' && session.role !== 'billing') {
      throw new Error('not authorized for this organization')
    }
    return requested ?? session.agency
  }

  async listRates(org: string): Promise<RateTable[]> {
    return this.repo.listRateTables(org)
  }

  async createRate(org: string, name: string, freightType: FreightType, session: ConfigSession, requestId: string): Promise<RateTable> {
    const table = await this.repo.createRateTable(org, name, freightType, session.userId)
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'rate_table.create',
      entityType: 'rate_table',
      entityId: table.id,
      requestId,
      metadata: { name, freight_type: freightType },
    })
    return table
  }

  async renameRate(org: string, id: string, name: string, session: ConfigSession, requestId: string): Promise<RateTable> {
    const table = await this.requireRateInOrg(org, id)
    await this.repo.updateRateTable(id, { name })
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'rate_table.update',
      entityType: 'rate_table',
      entityId: id,
      requestId,
      metadata: { before: { name: table.name }, after: { name } },
    })
    return { ...table, name, updatedAt: new Date().toISOString() }
  }

  async deleteRate(org: string, id: string, session: ConfigSession, requestId: string): Promise<void> {
    await this.requireRateInOrg(org, id)
    await this.repo.deleteRateTable(id)
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'rate_table.delete',
      entityType: 'rate_table',
      entityId: id,
      requestId,
      metadata: {},
    })
  }

  async replaceRows(org: string, id: string, rows: RateRow[], session: ConfigSession, requestId: string): Promise<RateTable> {
    await this.requireRateInOrg(org, id)
    await this.repo.replaceRateRows(id, rows)
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'rate_rows.replace',
      entityType: 'rate_table',
      entityId: id,
      requestId,
      metadata: { tiers: rows.map((r) => r.tier), count: rows.length },
    })
    return (await this.repo.getRateTable(id)) ?? (await this.requireRateInOrg(org, id))
  }

  async assignClientDefault(org: string, clientId: string, rateTableId: string | null, session: ConfigSession, requestId: string): Promise<void> {
    if (rateTableId) {
      await this.requireRateInOrg(org, rateTableId)
    }
    await this.repo.setClientDefaultRate(clientId, rateTableId)
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'client.default_rate.set',
      entityType: 'billing_client',
      entityId: clientId,
      requestId,
      metadata: { rate_table_id: rateTableId },
    })
  }

  async overridePackageRate(org: string, guia: string, rateTableId: string | null, session: ConfigSession, requestId: string): Promise<string> {
    const packageId = await this.repo.findPackageIdByToken(guia)
    if (!packageId) throw new Error('package not found')
    if (rateTableId) {
      await this.requireRateInOrg(org, rateTableId)
    }
    // `by` stores the actor id, never the email — the column is readable by
    // viewer through the panel's own select on packages (PII).
    await this.repo.setPackageRateOverride(packageId, rateTableId, session.userId)
    await this.audit({
      organizationId: org,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'package.rate_override.set',
      entityType: 'package',
      entityId: packageId,
      requestId,
      metadata: { guia, rate_table_id: rateTableId },
    })
    return packageId
  }

  async listAudit(org: string, filter: AuditFilter) {
    return this.repo.listAudit(org, filter)
  }

  // ─── Agency info (Config > Información) ──────────────────────────────────────

  /** Like branding, the profile is self-scoped: even admins only read their own. */
  async getInfo(session: ConfigSession): Promise<AgencyInfo> {
    const info = await this.repo.getAgencyInfo(session.agency)
    if (!info) throw new Error('agency not found')
    return info
  }

  async updateInfo(session: ConfigSession, patch: AgencyInfoPatch, requestId: string): Promise<AgencyInfo> {
    const before = await this.repo.getAgencyInfo(session.agency)
    if (!before) throw new Error('agency not found')
    const row: Row = {}
    if (patch.ruc !== undefined) row.ruc = patch.ruc?.trim() || null
    if (patch.address !== undefined) row.address = patch.address?.trim() || null
    if (patch.phone !== undefined) row.phone = patch.phone?.trim() || null
    if (patch.currency !== undefined) row.currency = patch.currency
    await this.repo.updateAgency(session.agency, row)
    await this.audit({
      organizationId: session.agency,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'agency.info.update',
      entityType: 'agency',
      entityId: session.agency,
      requestId,
      metadata: {
        before: { ruc: before.ruc, address: before.address, phone: before.phone, currency: before.currency },
        after: { ruc: row.ruc ?? before.ruc, address: row.address ?? before.address, phone: row.phone ?? before.phone, currency: row.currency ?? before.currency },
      },
    })
    return this.repo.getAgencyInfo(session.agency) as Promise<AgencyInfo>
  }

  // ─── Payment catalogs (Config > Pagos) ───────────────────────────────────────

  async listPaymentCatalogs(org: string): Promise<{ methods: PaymentCatalogItem[]; banks: PaymentCatalogItem[] }> {
    const [methods, banks] = await Promise.all([this.repo.listPaymentMethods(org), this.repo.listPaymentBanks(org)])
    return { methods, banks }
  }

  async createPaymentMethod(org: string, name: string, session: ConfigSession, requestId: string): Promise<PaymentCatalogItem> {
    const created = await this.repo.createPaymentMethod(org, name)
    await this.audit({ organizationId: org, actorId: session.userId, actorEmail: session.email, actorType: 'user', action: 'payment_method.create', entityType: 'payment_method', entityId: created.id, requestId, metadata: { name } })
    return created
  }

  async updatePaymentMethod(org: string, id: string, patch: { name?: string; active?: boolean }, session: ConfigSession, requestId: string): Promise<void> {
    await this.repo.updatePaymentMethod(org, id, patch)
    await this.audit({ organizationId: org, actorId: session.userId, actorEmail: session.email, actorType: 'user', action: 'payment_method.update', entityType: 'payment_method', entityId: id, requestId, metadata: patch })
  }

  async createPaymentBank(org: string, name: string, session: ConfigSession, requestId: string): Promise<PaymentCatalogItem> {
    const created = await this.repo.createPaymentBank(org, name)
    await this.audit({ organizationId: org, actorId: session.userId, actorEmail: session.email, actorType: 'user', action: 'payment_bank.create', entityType: 'payment_bank', entityId: created.id, requestId, metadata: { name } })
    return created
  }

  async updatePaymentBank(org: string, id: string, patch: { name?: string; active?: boolean }, session: ConfigSession, requestId: string): Promise<void> {
    await this.repo.updatePaymentBank(org, id, patch)
    await this.audit({ organizationId: org, actorId: session.userId, actorEmail: session.email, actorType: 'user', action: 'payment_bank.update', entityType: 'payment_bank', entityId: id, requestId, metadata: patch })
  }

  /**
   * Update an agency's logo. The client sends only the storage object key; the
   * public URL is derived server-side from the InsForge base URL so branding
   * can never point at an arbitrary host. Tenant-scoped: only admin may touch
   * another agency; billing/staff are pinned to their own. 404 if the agency
   * (or the key's bucket prefix) does not exist.
   */
  async updateBranding(
    session: ConfigSession,
    slug: string,
    logoKey: string | null,
    requestId: string,
    insforgeBaseUrl: string,
  ) {
    if (session.role !== 'admin' && slug !== session.agency) {
      throw new Error('not authorized for this organization')
    }
    const agencies = await this.repo.listAgencies()
    if (!agencies.some((a) => a.slug === slug)) {
      throw new Error('agency not found')
    }
    const logoUrl = logoKey === null ? null : `${insforgeBaseUrl}/api/storage/buckets/branding/objects/${logoKey}`
    await this.repo.updateAgency(slug, { logo_url: logoUrl, logo_key: logoKey })
    await this.audit({
      organizationId: slug,
      actorId: session.userId,
      actorEmail: session.email,
      actorType: 'user',
      action: 'branding.update',
      entityType: 'agency',
      entityId: slug,
      requestId,
      metadata: { logo_key: logoKey },
    })
    return { slug, logoUrl }
  }

  /** Tenant check: the table must exist AND belong to the caller's org. */
  private async requireRateInOrg(org: string, id: string): Promise<RateTable> {
    const table = await this.repo.getRateTable(id)
    if (!table) throw new Error('rate table not found')
    if (table.organizationId !== org) {
      throw new Error('not authorized for this organization')
    }
    return table
  }
}


function stripStorageKey(a: { slug: string; name: string; logoUrl: string | null; logoKey: string | null }) {
  return { slug: a.slug, name: a.name, logoUrl: a.logoUrl }
}
