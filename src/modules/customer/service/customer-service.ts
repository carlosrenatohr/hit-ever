import { normalizeClientName } from '../../billing/ingest/normalize/client.js'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CustomerRepository } from '../repo/customer-repo.js'
import type { CreateCustomerInput, CustomerDeletePreview, CustomerListFilter, CustomerPage, UpdateCustomerInput } from '../domain/types.js'

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
    return this.repo.get(id, organizationId).then((c) => (c && !c.deletedAt ? c : null))
  }

  deletePreview(id: string, organizationId: string): Promise<CustomerDeletePreview | null> {
    return this.repo.deletePreview(id, organizationId)
  }

  /** Soft delete (never physical). Audits client.delete with the impact counts. */
  async delete(
    id: string,
    organizationId: string,
    actor: CustomerActor,
    requestId?: string,
    reason?: string | null,
  ): Promise<{ id: string; deleted: true }> {
    const before = await this.repo.get(id, organizationId)
    if (!before || before.deletedAt) throw new Error('Customer not found.')
    const preview = await this.repo.deletePreview(id, organizationId)
    const deleted = await this.repo.delete(id, organizationId, actor.userId, reason ?? null)
    if (!deleted) throw new Error('Customer not found.')
    await this.repo.insertAudit({
      organizationId,
      actorId: actor.userId,
      actorEmail: actor.email,
      actorType: 'user',
      action: 'client.delete',
      entityType: 'billing_client',
      entityId: id,
      requestId: requestId ?? null,
      metadata: {
        name: before.name,
        casillero: before.casillero,
        companyName: before.companyName,
        packageCount: preview?.packageCount ?? 0,
        invoiceCount: preview?.invoiceCount ?? 0,
        reason: reason ?? null,
        deletedAt: deleted.deletedAt ?? new Date().toISOString(),
      },
    })
    return { id, deleted: true }
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
      defaultRateCardId: input.defaultRateCardId ?? null,
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
    if (before?.deletedAt) throw new Error('Customer not found.')
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
    if (input.defaultRateCardId !== undefined) patch.defaultRateCardId = input.defaultRateCardId
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