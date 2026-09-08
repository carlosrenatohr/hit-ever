import { describe, expect, it, vi } from 'vitest'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CustomerRepository } from '../repo/customer-repo.js'
import { CustomerService } from './customer-service.js'

function client(over: Partial<BillingClient> = {}): BillingClient {
  return { id: 'c1', name: 'Ana Maria', nameNormalized: 'ana maria', casillero: null, toReview: false, email: null, phone: null, address: null, companyName: null, taxId: null, active: true, packageCount: 0, defaultRateId: null, defaultRateCardId: null, ...over }
}

function repo(over: Partial<CustomerRepository> = {}): CustomerRepository {
  return { create: vi.fn(async () => client()), list: vi.fn(), get: vi.fn(), update: vi.fn(), insertAudit: vi.fn(async () => {}), ...over } as unknown as CustomerRepository
}

describe('CustomerService', () => {
  it('normalizes names and trims contact and lifecycle fields before creating records', async () => {
    const create = vi.fn(async () => client())
    const service = new CustomerService(repo({ create }))

    await service.create({ name: '  ANA   MARIA  ', casillero: ' A-7 ', email: ' ana@test.com ', phone: ' 8888 ', address: ' Dirección ', companyName: '  Ana S.A. ', taxId: ' J123 ' }, 'hit')

    expect(create).toHaveBeenCalledWith({
      organizationId: 'hit',
      name: 'Ana Maria',
      nameNormalized: 'ana maria',
      casillero: 'A-7',
      toReview: false,
      email: 'ana@test.com',
      phone: '8888',
      address: 'Dirección',
      companyName: 'Ana S.A.',
      taxId: 'J123',
      active: true,
      defaultRateId: null,
      defaultRateCardId: null,
    })
  })

  it('rejects blank names', async () => {
    const service = new CustomerService(repo())
    await expect(service.create({ name: '   ' }, 'hit')).rejects.toThrow('Customer name is required.')
  })

  it('updates the normalized name and review flag', async () => {
    const update = vi.fn(async () => client({ toReview: true }))
    const service = new CustomerService(repo({ update }))

    await service.update('c1', { name: '  BETA  ', toReview: true }, 'hit')

    expect(update).toHaveBeenCalledWith('c1', { name: 'Beta', nameNormalized: 'beta', toReview: true }, 'hit')
  })

  it('audits a create with the actor', async () => {
    const insertAudit = vi.fn(async () => {})
    const service = new CustomerService(repo({ insertAudit }))

    await service.create({ name: 'Ana' }, 'hit', { userId: 'u1', email: 'a@t.com' }, 'req-1')

    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'client.create', actorId: 'u1', requestId: 'req-1', entityId: 'c1' }))
  })

  it('audits a deactivate as client.deactivate with before/after changes', async () => {
    const before = client({ active: true })
    const after = client({ active: false })
    const insertAudit = vi.fn(async () => {})
    const service = new CustomerService(repo({ get: vi.fn(async () => before), update: vi.fn(async () => after), insertAudit }))

    await service.update('c1', { active: false }, 'hit', { userId: 'u1', email: 'a@t.com' })

    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'client.deactivate', entityId: 'c1' }))
    const call = insertAudit.mock.calls[0][0] as { metadata: { changes: Record<string, { before: unknown; after: unknown }> } }
    expect(call.metadata.changes.active).toEqual({ before: true, after: false })
  })
})