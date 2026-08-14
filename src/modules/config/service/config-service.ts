// ============================================================================
// ConfigService — orchestrates branding, self-managed rates and the audit log.
// ============================================================================
// Every write is tenant-scoped: the organization comes from the session (never
// the payload); a non-admin caller can only touch their own agency's rate
// tables. Writes are audited in audit_logs (ADR-011) with the same actor and
// a request_id propagated from the route.

import type { FreightType } from '../../billing/domain/enums.js'
import type { ConfigSession } from '../middleware/auth.js'
import type { AuditFilter, RateTable, RateRow } from '../domain/types.js'
import type { ConfigRepository } from '../repo/config-repo.js'

export class ConfigService {
  constructor(private repo: ConfigRepository) {}

  async getBranding() {
    return this.repo.listAgencies()
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
    await this.repo.insertAudit({
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
    await this.repo.insertAudit({
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
    await this.repo.insertAudit({
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
    await this.repo.insertAudit({
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
    await this.repo.insertAudit({
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
    await this.repo.setPackageRateOverride(packageId, rateTableId, session.email)
    await this.repo.insertAudit({
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
