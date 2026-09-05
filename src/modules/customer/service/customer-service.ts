import { normalizeClientName } from '../../billing/ingest/normalize/client.js'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CreateCustomerInput, CustomerListFilter, CustomerPage, UpdateCustomerInput } from '../domain/types.js'
import type { CustomerRepository } from '../repo/customer-repo.js'

function requireName(value: string | undefined): string {
  const name = value?.trim() ?? ''
  if (!name) throw new Error('Customer name is required.')
  return name
}

export class CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  list(filter: CustomerListFilter): Promise<CustomerPage> {
    return this.repo.list(filter)
  }

  get(id: string, organizationId?: string): Promise<BillingClient | null> {
    return this.repo.get(id, organizationId)
  }

  async create(input: CreateCustomerInput, organizationId: string): Promise<BillingClient> {
    const { display, key } = normalizeClientName(requireName(input.name))
    return this.repo.create({
      organizationId,
      name: display,
      nameNormalized: key,
      casillero: input.casillero?.trim() || null,
      toReview: input.toReview ?? false,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
    })
  }

  async update(id: string, input: UpdateCustomerInput, organizationId?: string): Promise<BillingClient | null> {
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
    return this.repo.update(id, patch, organizationId)
  }
}
