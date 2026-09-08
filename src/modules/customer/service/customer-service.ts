import { normalizeClientName } from '../../billing/ingest/normalize/client.js'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CustomerRepository } from '../repo/customer-repo.js'
import type { CreateCustomerInput, CustomerListFilter, CustomerPage, UpdateCustomerInput } from '../domain/types.js'

function requireName(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) throw new Error('Customer name is required.')
  return trimmed
}

/** Actor that triggered a mutation — feeds the audit trail. */
export interface CustomerActor {
  userId: string
  email: string | null
}

const EDITABLE_FIELDS = ['name', 'nameNormalized', 'casillero', 'toReview', 'email', 'phone', 'address', 'companyName', 'taxId', 'active', 'defaultRateId'] as const

export class CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  list(filter: CustomerListFilter): Promise<CustomerPage> {
    return this.repo.list(filter)
  }

  get(id: string, organizationId?: string): Promise<BillingClient | null> {
    return this.repo.get(id, organizationId)
  }

  async create(input: CreateCustomerInput, organizationId: string, actor?: CustomerActor, requestId?: string): Promise<BillingClient> {
    const { display, key } = normalizeClientName(requireName(input.name))
    const created = await this.repo.create({
      organizationId,
      name: display,
      nameNormalized: key,
      casillero: input.casillero?.trim() || null,
      toReview: input.toReview ?? false,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      companyName: input.companyName?.trim() || null,
      taxId: input.taxId?.trim() || null,
      active: input.active ?? true,
      defaultRateId: input.defaultRateTableId ?? null,
    })
    if (actor) {
      await this.repo.insertAudit({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        actorType: 'user',
        action: 'client.create',
        entityType: 'billing_client',
        entityId: created.id,
        requestId: requestId ?? null,
        metadata: { name: created.name, companyName: created.companyName, taxId: created.taxId, active: created.active },
      })
    }
    return created
  }

  async update(id: string, input: UpdateCustomerInput, organizationId: string, actor?: CustomerActor, requestId?: string): Promise<BillingClient | null> {
    const before = actor ? await this.repo.get(id, organizationId) : undefined
    const patch: Parameters<CustomerRepository['update']>[1] = {}
    if (input.name !== undefined) {
      const { display, key } = normalizeClientName(requireName(input.name))
      patch.name = display
      patch.nameNormalized = key
    }
    if (input.casillero !== undefined) patch.casillero = input.casillero?.trim() || null
    if (input.toReview !== undefined) patch.toReview = input.toReview
    if (input.email !== undefined) patch.email = input.email?.trim() || null
    if (input.phone !== undefined) patch.phone = input.phone?.trim() || null
    if (input.address !== undefined) patch.address = input.address?.trim() || null
    if (input.companyName !== undefined) patch.companyName = input.companyName?.trim() || null
    if (input.taxId !== undefined) patch.taxId = input.taxId?.trim() || null
    if (input.active !== undefined) patch.active = input.active
    if (input.defaultRateTableId !== undefined) patch.defaultRateId = input.defaultRateTableId
    const updated = await this.repo.update(id, patch, organizationId)
    if (actor && before && updated) {
      const action =
        before.active === true && updated.active === false ? 'client.deactivate' : before.active === false && updated.active === true ? 'client.reactivate' : 'client.update'
      const changes: Record<string, { before: unknown; after: unknown }> = {}
      for (const key of EDITABLE_FIELDS) {
        const prev = before[key]
        const next = updated[key]
        if (prev !== next) changes[key] = { before: prev, after: next }
      }
      await this.repo.insertAudit({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        actorType: 'user',
        action,
        entityType: 'billing_client',
        entityId: id,
        requestId: requestId ?? null,
        metadata: { changes },
      })
    }
    return updated
  }
}