import type { CloudflareBindings } from '../../../types/index.js'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CreateCustomerInput, CustomerListFilter, CustomerPage, UpdateCustomerInput } from '../domain/types.js'

interface BillingClientDbRow {
  id: string
  name: string
  name_normalized: string
  casillero: string | null
  to_review: boolean
  email: string | null
  phone: string | null
  address: string | null
  default_rate_id: string | null
}

export interface CustomerRepository {
  list(filter: CustomerListFilter): Promise<CustomerPage>
  get(id: string, organizationId?: string): Promise<BillingClient | null>
  create(input: { organizationId: string; name: string; nameNormalized: string; casillero: string | null; toReview: boolean; email: string | null; phone: string | null; address: string | null }): Promise<BillingClient>
  update(id: string, input: { name?: string; nameNormalized?: string; casillero?: string | null; toReview?: boolean; email?: string | null; phone?: string | null; address?: string | null; defaultRateId?: string | null }, organizationId?: string): Promise<BillingClient | null>
}

function toDomain(row: BillingClientDbRow): BillingClient {
  return {
    id: row.id,
    name: row.name,
    nameNormalized: row.name_normalized,
    casillero: row.casillero ?? null,
    toReview: row.to_review,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    defaultRateId: row.default_rate_id ?? null,
  }
}

export class InsforgeCustomerRepo implements CustomerRepository {
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(apiUrl: string, apiKey: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/api/database/records`
    this.headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  }

  private async fetchRows<T>(query: string): Promise<T[]> {
    const res = await fetch(`${this.base}/billing_clients?${query}`, { headers: this.headers })
    if (!res.ok) throw new Error(`InsForge GET billing_clients → ${res.status}`)
    return (await res.json()) as T[]
  }

  private async fetchRowsWithCount<T>(query: string): Promise<{ rows: T[]; count: number }> {
    const res = await fetch(`${this.base}/billing_clients?${query}`, {
      headers: { ...this.headers, Prefer: 'count=exact' },
    })
    if (!res.ok) throw new Error(`InsForge GET billing_clients → ${res.status}`)
    const rows = (await res.json()) as T[]
    const range = res.headers.get('content-range') ?? ''
    return { rows, count: Number(range.split('/')[1]) || rows.length }
  }

  private async post<T>(row: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/billing_clients`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    })
    if (!res.ok) throw new Error(`InsForge POST billing_clients → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const rows = (await res.json()) as T[]
    return rows[0]
  }

  private async patch(id: string, row: Record<string, unknown>, organizationId?: string): Promise<BillingClientDbRow | null> {
    // Tenant scope on writes: the org filter makes a cross-tenant PATCH a no-op.
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const res = await fetch(`${this.base}/billing_clients?id=eq.${encodeURIComponent(id)}${orgFilter}`, {
      method: 'PATCH',
      headers: { ...this.headers, Prefer: 'return=representation' },
      body: JSON.stringify(row),
    })
    if (!res.ok) throw new Error(`InsForge PATCH billing_clients → ${res.status}`)
    const rows = (await res.json()) as BillingClientDbRow[]
    return rows[0] ?? null
  }

  async list(filter: CustomerListFilter): Promise<CustomerPage> {
    const page = Math.max(1, filter.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25))
    const parts = ['select=id,name,name_normalized,casillero,to_review,email,phone,address,default_rate_id', 'order=name.asc']
    parts.push(`organization_id=eq.${encodeURIComponent(filter.organizationId)}`)
    if (filter.search) {
      const search = filter.search.replace(/[(),*]/g, '')
      parts.push(`name=ilike.*${encodeURIComponent(search)}*`)
    }
    if (filter.toReview !== undefined) parts.push(`to_review=eq.${filter.toReview}`)
    parts.push(`limit=${pageSize}`, `offset=${(page - 1) * pageSize}`)
    const { rows, count } = await this.fetchRowsWithCount<BillingClientDbRow>(parts.join('&'))
    return { rows: rows.map(toDomain), count }
  }

  async get(id: string, organizationId?: string): Promise<BillingClient | null> {
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const rows = await this.fetchRows<BillingClientDbRow>(`id=eq.${encodeURIComponent(id)}${orgFilter}&select=id,name,name_normalized,casillero,to_review,email,phone,address,default_rate_id&limit=1`)
    return rows[0] ? toDomain(rows[0]) : null
  }

  async create(input: { organizationId: string; name: string; nameNormalized: string; casillero: string | null; toReview: boolean; email: string | null; phone: string | null; address: string | null; defaultRateId?: string | null }): Promise<BillingClient> {
    const row = await this.post<BillingClientDbRow>({
      organization_id: input.organizationId,
      name: input.name,
      name_normalized: input.nameNormalized,
      casillero: input.casillero,
      to_review: input.toReview,
      email: input.email,
      phone: input.phone,
      address: input.address,
      default_rate_id: input.defaultRateId ?? null,
    })
    return toDomain(row)
  }

  async update(id: string, input: { name?: string; nameNormalized?: string; casillero?: string | null; toReview?: boolean; email?: string | null; phone?: string | null; address?: string | null }, organizationId?: string): Promise<BillingClient | null> {
    const row: Record<string, unknown> = {}
    if (input.name !== undefined) row.name = input.name
    if (input.nameNormalized !== undefined) row.name_normalized = input.nameNormalized
    if (input.casillero !== undefined) row.casillero = input.casillero
    if (input.toReview !== undefined) row.to_review = input.toReview
    if (input.email !== undefined) row.email = input.email
    if (input.phone !== undefined) row.phone = input.phone
    if (input.address !== undefined) row.address = input.address
    if (input.defaultRateId !== undefined) row.default_rate_id = input.defaultRateId
    row.updated_at = new Date().toISOString()
    const updated = await this.patch(id, row, organizationId)
    return updated ? toDomain(updated) : null
  }
}

export function getCustomerRepo(env: CloudflareBindings): CustomerRepository {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    throw new Error('Customer module requires INSFORGE_API_URL and INSFORGE_API_KEY.')
  }
  return new InsforgeCustomerRepo(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
}

export type CustomerRepositoryInput = CreateCustomerInput | UpdateCustomerInput
