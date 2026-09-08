// ============================================================================
// Storage-agnostic config persistence port + InsForge adapter.
// ============================================================================
// Same pattern as the billing module (src/modules/billing/repo/billing-repo.ts):
// routes/services depend on the interface, never on a concrete client. The
// InsForge adapter uses the Worker admin key (RLS bypass) over the
// PostgREST-style REST API. Audit writes go here too (ADR-011), with
// request_id propagated from the request for observability correlation.

import type { CloudflareBindings } from '../../../types/index.js'
import type { FreightType } from '../../billing/domain/enums.js'
import type { ActorType, Agency, AgencyInfo, AuditFilter, AuditLogEntry, ChargeConcept, CurrencyCode, PaymentCatalogItem, RateCard, RateCardEntryInput, RateCardStructure, RateCardVersion, RateTable, RateRow } from '../domain/types.js'

// ─── DB row shapes (snake_case, as returned by PostgREST) ─────────────────────
interface AgencyRow {
  slug: string
  name: string
  logo_url: string | null
  logo_key: string | null
}

interface RateTableRow {
  id: string
  organization_id: string
  name: string
  freight_type: FreightType
  created_at: string
  updated_at: string
  rate_rows: RateRowDb[]
}

interface RateRowDb {
  tier: string
  price: number
  cost: number
  price_model: string
}

interface RateCardEntryDb {
  id: string
  service_type: string
  name: string
  unit: string
  price: number
  cost: number
}

interface RateCardVersionDb {
  id: string
  version: number
  price_model: string
  currency: string
  status: string
  created_at: string
  updated_at: string
  rate_card_entries: RateCardEntryDb[]
}

interface RateCardRow {
  id: string
  organization_id: string
  name: string
  structure: string
  created_at: string
  updated_at: string
  rate_card_versions: RateCardVersionDb[]
}

// Alias for the domain type used by the config service.
import type { PriceModel } from '../domain/types.js'

interface AuditRow {
  id: number
  organization_id: string
  actor_id: string | null
  actor_email: string | null
  actor_type: ActorType
  action: string
  entity_type: string
  entity_id: string | null
  request_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export type Row = Record<string, unknown>

// ─── Port ───────────────────────────────────────────────────────────────────
export interface ConfigRepository {
  listAgencies(): Promise<Agency[]>
  updateAgency(slug: string, patch: Row): Promise<void>
  listRateTables(organizationId: string): Promise<RateTable[]>
  getRateTable(id: string): Promise<RateTable | null>
  createRateTable(organizationId: string, name: string, freightType: FreightType, by: string | null): Promise<RateTable>
  updateRateTable(id: string, patch: Row): Promise<void>
  deleteRateTable(id: string): Promise<void>
  replaceRateRows(rateTableId: string, rows: RateRow[]): Promise<void>
  setClientDefaultRate(clientId: string, rateTableId: string | null): Promise<void>
  setPackageRateOverride(packageId: string, rateTableId: string | null, by: string | null): Promise<void>
  // Rate cards v2 (plan -> version -> entries):
  listRateCards(organizationId: string): Promise<RateCard[]>
  getRateCard(id: string): Promise<RateCard | null>
  createRateCard(input: { organizationId: string; name: string; priceModel: PriceModel; currency: string; entries: RateCardEntryInput[]; by: string | null }): Promise<RateCard>
  updateRateCard(id: string, patch: Row): Promise<void>
  deleteRateCard(id: string): Promise<void>
  replaceCardEntries(rateCardId: string, entries: RateCardEntryInput[]): Promise<void>
  setClientDefaultRateCard(clientId: string, rateCardId: string | null): Promise<void>
  setPackageRateOverrideCard(packageId: string, rateCardId: string | null, by: string | null): Promise<void>
  findPackageIdByToken(token: string): Promise<string | null>
  getAgencyInfo(slug: string): Promise<AgencyInfo | null>
  listChargeConcepts(organizationId: string): Promise<ChargeConcept[]>
  createChargeConcept(organizationId: string, name: string, suggestedPrice: number | null): Promise<ChargeConcept>
  updateChargeConcept(organizationId: string, id: string, patch: { name?: string; active?: boolean; suggestedPrice?: number | null }): Promise<void>
  deleteChargeConcept(organizationId: string, id: string): Promise<void>
  /** Whether an invoice "other" line references this concept (blocks deletion). */
  isConceptInUse(conceptId: string): Promise<boolean>
  listPaymentMethods(organizationId: string): Promise<PaymentCatalogItem[]>
  createPaymentMethod(organizationId: string, name: string): Promise<PaymentCatalogItem>
  updatePaymentMethod(organizationId: string, id: string, patch: { name?: string; active?: boolean }): Promise<void>
  deletePaymentMethod(organizationId: string, id: string): Promise<void>
  listPaymentBanks(organizationId: string): Promise<PaymentCatalogItem[]>
  createPaymentBank(organizationId: string, name: string): Promise<PaymentCatalogItem>
  updatePaymentBank(organizationId: string, id: string, patch: { name?: string; active?: boolean }): Promise<void>
  deletePaymentBank(organizationId: string, id: string): Promise<void>
  listAudit(organizationId: string, filter: AuditFilter): Promise<{ rows: AuditLogEntry[]; count: number }>
  insertAudit(entry: {
    organizationId: string
    actorId: string | null
    actorEmail: string | null
    actorType: ActorType
    action: string
    entityType: string
    entityId: string | null
    requestId: string | null
    metadata?: Record<string, unknown>
  }): Promise<void>
}

// ─── InsForge adapter ─────────────────────────────────────────────────────────
export class InsforgeConfigRepo implements ConfigRepository {
  private base: string
  private headers: Record<string, string>

  constructor(apiUrl: string, apiKey: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/api/database/records`
    this.headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  }

  private async get<T>(table: string, query = ''): Promise<T[]> {
    const res = await fetch(`${this.base}/${table}${query ? `?${query}` : ''}`, { headers: this.headers })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    return (await res.json()) as T[]
  }

  /** GET returning both rows and the exact total count (PostgREST Content-Range). */
  private async getWithCount<T>(table: string, query: string): Promise<{ rows: T[]; count: number }> {
    const res = await fetch(`${this.base}/${table}?${query}`, {
      headers: { ...this.headers, Prefer: 'count=exact' },
    })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    const rows = (await res.json()) as T[]
    const range = res.headers.get('content-range') ?? ''
    const count = Number(range.split('/')[1]) || rows.length
    return { rows, count }
  }

  private async post<T>(table: string, rows: Row[], opts: { onConflict?: string; representation?: boolean } = {}): Promise<T[]> {
    if (rows.length === 0) return []
    const q = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : ''
    const prefer = [opts.onConflict ? 'resolution=merge-duplicates' : null, opts.representation ? 'return=representation' : 'return=minimal']
      .filter(Boolean)
      .join(',')
    const res = await fetch(`${this.base}/${table}${q}`, { method: 'POST', headers: { ...this.headers, Prefer: prefer }, body: JSON.stringify(rows) })
    if (!res.ok) throw new Error(`InsForge POST ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return opts.representation ? ((await res.json()) as T[]) : []
  }

  private async patch(table: string, query: string, patch: Row): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'PATCH', headers: { ...this.headers, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    if (!res.ok) throw new Error(`InsForge PATCH ${table} → ${res.status}`)
  }

  private async del(table: string, query: string): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'DELETE', headers: { ...this.headers, Prefer: 'return=minimal' } })
    if (!res.ok) throw new Error(`InsForge DELETE ${table} → ${res.status}`)
  }

  // ─── Implementations ─────────────────────────────────────────────────────────

  async listAgencies(): Promise<Agency[]> {
    const rows = await this.get<AgencyRow>('agencies', 'select=slug,name,logo_url,logo_key&order=slug')
    return rows.map((r) => ({ slug: r.slug, name: r.name, logoUrl: r.logo_url, logoKey: r.logo_key }))
  }

  async updateAgency(slug: string, patch: Row): Promise<void> {
    await this.patch('agencies', `slug=eq.${encodeURIComponent(slug)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async listRateTables(organizationId: string): Promise<RateTable[]> {
    const rows = await this.get<RateTableRow>(
      'rate_tables',
      `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,organization_id,name,freight_type,created_at,updated_at,rate_rows(tier,price,cost,price_model)&order=name`,
    )
    return rows.map(toRateTable)
  }

  async getRateTable(id: string): Promise<RateTable | null> {
    const rows = await this.get<RateTableRow>(
      'rate_tables',
      `id=eq.${encodeURIComponent(id)}&select=id,organization_id,name,freight_type,created_at,updated_at,rate_rows(tier,price,cost,price_model)&limit=1`,
    )
    return rows[0] ? toRateTable(rows[0]) : null
  }

  async createRateTable(organizationId: string, name: string, freightType: FreightType, by: string | null): Promise<RateTable> {
    const created = await this.post<RateTableRow>('rate_tables', [{ organization_id: organizationId, name, freight_type: freightType, created_by: by }], {
      representation: true,
    })
    if (!created[0]) throw new Error('Rate table was not created.')
    return toRateTable(created[0])
  }

  async updateRateTable(id: string, patch: Row): Promise<void> {
    await this.patch('rate_tables', `id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async deleteRateTable(id: string): Promise<void> {
    await this.del('rate_tables', `id=eq.${encodeURIComponent(id)}`)
  }

  async replaceRateRows(rateTableId: string, rows: RateRow[]): Promise<void> {
    if (rows.length === 0) {
      await this.del('rate_rows', `rate_table_id=eq.${encodeURIComponent(rateTableId)}`)
      return
    }
    await this.post('rate_rows', rows.map((r) => ({ rate_table_id: rateTableId, tier: r.tier, price: r.price, cost: r.cost, price_model: r.priceModel ?? 'weight' })), {
      onConflict: 'rate_table_id,tier',
    })
    const keep = rows.map((r) => r.tier).join(',')
    await this.del('rate_rows', `rate_table_id=eq.${encodeURIComponent(rateTableId)}&tier=not.in.(${keep})`)
  }

  async setClientDefaultRate(clientId: string, rateTableId: string | null): Promise<void> {
    await this.patch('billing_clients', `id=eq.${encodeURIComponent(clientId)}`, { default_rate_id: rateTableId })
  }

  async setPackageRateOverride(packageId: string, rateTableId: string | null, by: string | null): Promise<void> {
    await this.patch('packages', `id=eq.${encodeURIComponent(packageId)}`, {
      rate_override_id: rateTableId,
      rate_override_by: by,
      rate_override_at: rateTableId ? new Date().toISOString() : null,
    })
  }

  // ─── Rate cards v2 ───────────────────────────────────────────────────────────

  private static readonly RATE_CARD_SELECT = `id,organization_id,name,structure,created_at,updated_at,rate_card_versions(id,version,price_model,currency,status,created_at,updated_at,rate_card_entries(id,service_type,name,unit,price,cost))`

  async listRateCards(organizationId: string): Promise<RateCard[]> {
    const rows = await this.get<RateCardRow>(
      'rate_cards',
      `organization_id=eq.${encodeURIComponent(organizationId)}&select=${InsforgeConfigRepo.RATE_CARD_SELECT}&order=name`,
    )
    return rows.map(toRateCard)
  }

  async getRateCard(id: string): Promise<RateCard | null> {
    const rows = await this.get<RateCardRow>('rate_cards', `id=eq.${encodeURIComponent(id)}&select=${InsforgeConfigRepo.RATE_CARD_SELECT}&limit=1`)
    return rows[0] ? toRateCard(rows[0]) : null
  }

  async createRateCard(input: {
    organizationId: string
    name: string
    priceModel: PriceModel
    currency: string
    entries: RateCardEntryInput[]
    by: string | null
  }): Promise<RateCard> {
    const card = await this.post<{ id: string }>('rate_cards', [{ organization_id: input.organizationId, name: input.name, created_by: input.by }], {
      representation: true,
    })
    if (!card[0]) throw new Error('rate card was not created')
    const version = await this.post<{ id: string }>(
      'rate_card_versions',
      [{ rate_card_id: card[0].id, price_model: input.priceModel, currency: input.currency, status: 'published', created_by: input.by }],
      { representation: true },
    )
    if (!version[0]) throw new Error('rate card version was not created')
    await this.post(
      'rate_card_entries',
      input.entries.map((e) => ({
        rate_card_version_id: version[0].id,
        service_type: e.serviceType,
        name: e.name,
        unit: 'lb',
        price: e.price,
        cost: e.cost,
      })),
    )
    const created = await this.getRateCard(card[0].id)
    if (!created) throw new Error('rate card was not created')
    return created
  }

  async updateRateCard(id: string, patch: Row): Promise<void> {
    await this.patch('rate_cards', `id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async deleteRateCard(id: string): Promise<void> {
    await this.del('rate_cards', `id=eq.${encodeURIComponent(id)}`)
  }

  async replaceCardEntries(rateCardId: string, entries: RateCardEntryInput[]): Promise<void> {
    const card = await this.getRateCard(rateCardId)
    if (!card) throw new Error('rate card not found')
    const versionId = card.currentVersion.id
    if (entries.length === 0) {
      await this.del('rate_card_entries', `rate_card_version_id=eq.${encodeURIComponent(versionId)}`)
      return
    }
    await this.post(
      'rate_card_entries',
      entries.map((e) => ({
        rate_card_version_id: versionId,
        service_type: e.serviceType,
        name: e.name,
        unit: 'lb',
        price: e.price,
        cost: e.cost,
      })),
      { onConflict: 'rate_card_version_id,service_type' },
    )
    const keep = entries.map((e) => e.serviceType).join(',')
    await this.del('rate_card_entries', `rate_card_version_id=eq.${encodeURIComponent(versionId)}&service_type=not.in.(${keep})`)
  }

  async setClientDefaultRateCard(clientId: string, rateCardId: string | null): Promise<void> {
    await this.patch('billing_clients', `id=eq.${encodeURIComponent(clientId)}`, { default_rate_card_id: rateCardId })
  }

  async setPackageRateOverrideCard(packageId: string, rateCardId: string | null, by: string | null): Promise<void> {
    await this.patch('packages', `id=eq.${encodeURIComponent(packageId)}`, {
      rate_override_card_id: rateCardId,
      rate_override_by: by,
      rate_override_at: rateCardId ? new Date().toISOString() : null,
    })
  }

  async listAudit(organizationId: string, filter: AuditFilter): Promise<{ rows: AuditLogEntry[]; count: number }> {
    const q: string[] = [`organization_id=eq.${encodeURIComponent(organizationId)}`]
    if (filter.action) q.push(`action=eq.${encodeURIComponent(filter.action)}`)
    if (filter.entityType) q.push(`entity_type=eq.${encodeURIComponent(filter.entityType)}`)
    if (filter.entityId) q.push(`entity_id=eq.${encodeURIComponent(filter.entityId)}`)
    if (filter.from) q.push(`created_at=gte.${encodeURIComponent(filter.from)}`)
    if (filter.to) q.push(`created_at=lte.${encodeURIComponent(filter.to)}`)
    const pageSize = Math.min(filter.pageSize ?? 50, 200)
    const offset = Math.min(((filter.page ?? 1) - 1) * pageSize, 10_000)
    q.push(`select=id,organization_id,actor_id,actor_email,actor_type,action,entity_type,entity_id,request_id,metadata,created_at`)
    q.push(`order=created_at.desc&limit=${pageSize}&offset=${offset}`)
    const { rows, count } = await this.getWithCount<AuditRow>('audit_logs', q.join('&'))
    return {
      rows: rows.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        actorType: r.actor_type,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        requestId: r.request_id,
        metadata: r.metadata ?? {},
        createdAt: r.created_at,
      })),
      count,
    }
  }

  async findPackageIdByToken(token: string): Promise<string | null> {
    const byAlmacen = await this.get<{ id: string }>('packages', `almacen_id=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    if (byAlmacen[0]) return byAlmacen[0].id
    const byTracking = await this.get<{ id: string }>('packages', `tracking_number=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    return byTracking[0]?.id ?? null
  }

  async insertAudit(entry: Parameters<ConfigRepository['insertAudit']>[0]): Promise<void> {
    await this.post('audit_logs', [
      {
        organization_id: entry.organizationId,
        actor_id: entry.actorId,
        actor_email: entry.actorEmail,
        actor_type: entry.actorType,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        request_id: entry.requestId,
        metadata: entry.metadata ?? {},
      },
    ])
  }

  async getAgencyInfo(slug: string): Promise<AgencyInfo | null> {
    const rows = await this.get<AgencyInfoRow>(
      'agencies',
      `slug=eq.${encodeURIComponent(slug)}&select=slug,name,ruc,address,phone,currency,is_scrapable,exchange_rate_nio_per_usd,exchange_rate_source,exchange_rate_updated_at,name_last_updated&limit=1`,
    )
    return rows[0] ? toAgencyInfo(rows[0]) : null
  }

  async listPaymentMethods(organizationId: string): Promise<PaymentCatalogItem[]> {
    const rows = await this.get<PaymentCatalogRow>('payment_methods', `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name,active&order=name`)
    return rows
  }

  async createPaymentMethod(organizationId: string, name: string): Promise<PaymentCatalogItem> {
    const created = await this.post<PaymentCatalogRow>('payment_methods', [{ organization_id: organizationId, name }], { representation: true })
    if (!created[0]) throw new Error('payment method was not created')
    return created[0]
  }

  async updatePaymentMethod(organizationId: string, id: string, patch: { name?: string; active?: boolean }): Promise<void> {
    // Tenant scope on the filter: a foreign id matches nothing (no-op).
    await this.patch('payment_methods', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async deletePaymentMethod(organizationId: string, id: string): Promise<void> {
    await this.del('payment_methods', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`)
  }

  async listPaymentBanks(organizationId: string): Promise<PaymentCatalogItem[]> {
    const rows = await this.get<PaymentCatalogRow>('payment_banks', `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name,active&order=name`)
    return rows
  }

  async createPaymentBank(organizationId: string, name: string): Promise<PaymentCatalogItem> {
    const created = await this.post<PaymentCatalogRow>('payment_banks', [{ organization_id: organizationId, name }], { representation: true })
    if (!created[0]) throw new Error('payment bank was not created')
    return created[0]
  }

  async updatePaymentBank(organizationId: string, id: string, patch: { name?: string; active?: boolean }): Promise<void> {
    await this.patch('payment_banks', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async deletePaymentBank(organizationId: string, id: string): Promise<void> {
    await this.del('payment_banks', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`)
  }

  async listChargeConcepts(organizationId: string): Promise<ChargeConcept[]> {
    const rows = await this.get<ChargeConceptRow>('charge_concepts', `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name,suggested_price,active&order=name`)
    return rows.map((r) => ({ id: r.id, name: r.name, suggestedPrice: r.suggested_price, active: r.active }))
  }

  async createChargeConcept(organizationId: string, name: string, suggestedPrice: number | null): Promise<ChargeConcept> {
    const created = await this.post<ChargeConceptRow>('charge_concepts', [{ organization_id: organizationId, name, suggested_price: suggestedPrice }], { representation: true })
    if (!created[0]) throw new Error('charge concept was not created')
    return { id: created[0].id, name: created[0].name, suggestedPrice: created[0].suggested_price, active: created[0].active }
  }

  async updateChargeConcept(organizationId: string, id: string, patch: { name?: string; active?: boolean; suggestedPrice?: number | null }): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.active !== undefined) row.active = patch.active
    if (patch.suggestedPrice !== undefined) row.suggested_price = patch.suggestedPrice
    await this.patch('charge_concepts', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`, row)
  }

  async deleteChargeConcept(organizationId: string, id: string): Promise<void> {
    await this.del('charge_concepts', `id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}`)
  }

  async isConceptInUse(conceptId: string): Promise<boolean> {
    const rows = await this.get<{ id: string }>('invoice_line_items', `concept_id=eq.${encodeURIComponent(conceptId)}&select=id&limit=1`)
    return rows.length > 0
  }
}

function toRateTable(r: RateTableRow): RateTable {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    freightType: r.freight_type,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rows: (r.rate_rows ?? []).map((row) => ({ tier: row.tier as RateRow['tier'], price: row.price, cost: row.cost, priceModel: (row.price_model ?? 'weight') as PriceModel })),
  }
}

function toRateCard(r: RateCardRow): RateCard {
  const versions: RateCardVersion[] = (r.rate_card_versions ?? [])
    .map((v) => ({
      id: v.id,
      version: v.version,
      priceModel: v.price_model as PriceModel,
      currency: v.currency as CurrencyCode,
      status: v.status as RateCardVersion['status'],
      entries: (v.rate_card_entries ?? [])
        .sort((a, b) => (a.service_type < b.service_type ? -1 : 1))
        .map((e) => ({
          id: e.id,
          serviceType: e.service_type as FreightType,
          name: e.name,
          unit: e.unit as RateCardVersion['entries'][number]['unit'],
          price: e.price,
          cost: e.cost,
        })),
    }))
    .sort((a, b) => b.version - a.version)
  const current = versions.find((v) => v.status === 'published') ?? versions[0]
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    structure: (r.structure ?? 'simple_pair') as RateCardStructure,
    currentVersion: current ?? { id: '', version: 0, priceModel: 'weight', currency: 'USD', status: 'published', entries: [] },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ─── Agency info + payment catalogs (InsForge adapter) ───────────────────────
interface AgencyInfoRow {
  slug: string
  name: string
  ruc: string | null
  address: string | null
  phone: string | null
  currency: CurrencyCode
  is_scrapable: boolean
  exchange_rate_nio_per_usd: number | null
  exchange_rate_source: string
  exchange_rate_updated_at: string | null
  name_last_updated: string | null
}

interface PaymentCatalogRow {
  id: string
  name: string
  active: boolean
}

interface ChargeConceptRow {
  id: string
  name: string
  suggested_price: number | null
  active: boolean
}

function toAgencyInfo(r: AgencyInfoRow): AgencyInfo {
  return {
    slug: r.slug,
    name: r.name,
    ruc: r.ruc ?? null,
    address: r.address ?? null,
    phone: r.phone ?? null,
    currency: r.currency,
    isScrapable: r.is_scrapable,
    exchangeRateNioPerUsd: r.exchange_rate_nio_per_usd ?? null,
    exchangeRateSource: (r.exchange_rate_source ?? 'manual') as AgencyInfo['exchangeRateSource'],
    exchangeRateUpdatedAt: r.exchange_rate_updated_at ?? null,
    nameLastUpdated: r.name_last_updated ?? null,
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export function getConfigRepo(env: CloudflareBindings): ConfigRepository {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    throw new Error('Config requires INSFORGE_API_URL and INSFORGE_API_KEY.')
  }
  return new InsforgeConfigRepo(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
}
