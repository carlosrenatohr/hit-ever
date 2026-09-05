import { describe, expect, it, vi } from 'vitest'
import type { BillingClient } from '../../billing/domain/types.js'
import type { CustomerRepository } from '../repo/customer-repo.js'
import { CustomerService } from './customer-service.js'

function client(over: Partial<BillingClient> = {}): BillingClient {
  return { id: 'c1', name: 'Ana Maria', nameNormalized: 'ana maria', casillero: null, toReview: false, email: null, phone: null, address: null, ...over }
}

describe('CustomerService', () => {
  it('normalizes names and trims contact fields before creating records', async () => {
    const create = vi.fn(async () => client())
    const service = new CustomerService({ create, list: vi.fn(), get: vi.fn(), update: vi.fn() } as unknown as CustomerRepository)

    await service.create({ name: '  ANA   MARIA  ', casillero: ' A-7 ', email: ' ana@test.com ', phone: ' 8888 ', address: ' Dirección ' }, 'hit')

    expect(create).toHaveBeenCalledWith({
      organizationId: 'hit',
      name: 'Ana Maria',
      nameNormalized: 'ana maria',
      casillero: 'A-7',
      toReview: false,
      email: 'ana@test.com',
      phone: '8888',
      address: 'Dirección',
    })
  })

  it('rejects blank names', async () => {
    const service = new CustomerService({ create: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn() } as unknown as CustomerRepository)
    await expect(service.create({ name: '   ' }, 'hit')).rejects.toThrow('Customer name is required.')
  })

  it('updates the normalized name and review flag', async () => {
    const update = vi.fn(async () => client({ toReview: true }))
    const service = new CustomerService({ create: vi.fn(), list: vi.fn(), get: vi.fn(), update } as unknown as CustomerRepository)

    await service.update('c1', { name: '  BETA  ', toReview: true }, 'hit')

    expect(update).toHaveBeenCalledWith('c1', { name: 'Beta', nameNormalized: 'beta', toReview: true }, 'hit')
  })
})
