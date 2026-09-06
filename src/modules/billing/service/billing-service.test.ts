import { describe, expect, it, vi } from 'vitest'
import type { InvoiceBundle } from '../repo/billing-repo.js'
import type { BillingRepository } from '../repo/billing-repo.js'
import { aggregateClose, aggregateYear, BillingService, computeStatus, paymentUsd, toView } from './billing-service.js'

describe('computeStatus', () => {
  it('keeps VOID terminal', () => {
    expect(computeStatus('VOID', 100, 100)).toBe('VOID')
  })
  it('PAID when fully covered, PARTIAL when partly, ISSUED when none', () => {
    expect(computeStatus('ISSUED', 100, 100)).toBe('PAID')
    expect(computeStatus('ISSUED', 100, 99.999)).toBe('PAID') // within tolerance
    expect(computeStatus('ISSUED', 100, 40)).toBe('PARTIAL')
    expect(computeStatus('ISSUED', 100, 0)).toBe('ISSUED')
  })
})

describe('paymentUsd', () => {
  it('passes USD through and converts NIO with a rate', () => {
    expect(paymentUsd('USD', 32.5)).toBe(32.5)
    expect(paymentUsd('NIO', 3650, 36.5)).toBe(100)
    expect(paymentUsd('NIO', 3650, null)).toBeNull() // no rate -> unreconciled
  })
})

function bundle(over: Partial<InvoiceBundle['header']>, lines: Partial<InvoiceBundle['lines'][number]>[] = [], payments: Partial<InvoiceBundle['payments'][number]>[] = []): InvoiceBundle {
  return {
    header: {
      id: 'i1', invoice_number: 1, fiscal_year: 2026, client_id: null, client_name_raw: 'Ana',
      issue_date: '2026-06-10', status: 'ISSUED', address: null, special_price: false, observations: null,
      tracking_orders: [], agent_id: null, created_at: '', updated_at: '', total: 0, profit: 0, paid_usd: 0, ...over,
    } as InvoiceBundle['header'],
    lines: lines.map((l, i) => ({ id: `l${i}`, invoice_id: 'i1', line_no: i + 1, description: null, freight_type: 'AIR', quantity_lbs: 1, unit: 'lbs', unit_price: 6.5, total: 6.5, list_price: null, freight_cost: 4.5, profit: 2, price_tier: 'REGULAR', price_off_catalog: false, ...l }) as InvoiceBundle['lines'][number]),
    payments: payments.map((p, i) => ({ id: `p${i}`, invoice_id: 'i1', method: 'CASH', bank: null, currency: 'USD', amount: 6.5, amount_usd: 6.5, fx_rate: null, paid_at: null, raw: null, quarantined: false, ...p }) as InvoiceBundle['payments'][number]),
    packages: [],
  }
}

describe('toView', () => {
  it('sums lines/payments and computes margin + outstanding', () => {
    const v = toView(bundle({ status: 'PARTIAL' }, [{ total: 32.5, profit: 10 }, { total: 7.5, profit: 3 }], [{ amount_usd: 20 }]))
    expect(v.total).toBe(40)
    expect(v.profit).toBe(13)
    expect(v.paidUsd).toBe(20)
    expect(v.outstanding).toBe(20)
    expect(v.margin).toBeCloseTo(0.325, 3)
  })
  it('void invoices have zero outstanding', () => {
    const v = toView(bundle({ status: 'VOID' }, [{ total: 50, profit: 10 }]))
    expect(v.outstanding).toBe(0)
  })
})

describe('aggregateClose', () => {
  it('sums by freight, skips VOID, totals receivables from headers', () => {
    const close = aggregateClose(2026, 6, [
      bundle({ status: 'PAID', total: 32.5, paid_usd: 32.5 }, [{ freight_type: 'AIR', total: 32.5, profit: 10, quantity_lbs: 5 }]),
      bundle({ status: 'ISSUED', total: 20, paid_usd: 0 }, [{ freight_type: 'MAR', total: 20, profit: 8, quantity_lbs: 8 }]),
      bundle({ status: 'VOID', total: 99 }, [{ freight_type: 'AIR', total: 99, profit: 50, quantity_lbs: 10 }]),
    ])
    expect(close.invoices).toBe(2)
    expect(close.revenue).toBe(52.5)
    expect(close.profit).toBe(18)
    expect(close.receivables).toBe(20)
    expect(close.byFreight.AIR).toEqual({ revenue: 32.5, profit: 10, lbs: 5 })
    expect(close.byFreight.MAR).toEqual({ revenue: 20, profit: 8, lbs: 8 })
  })
})

describe('publicReceipt', () => {
  it('exposes only customer-safe fields (no cost/profit/margin/freightCost)', async () => {
    const repo = {
      getPublicBundle: async () =>
        bundle({ status: 'PAID', invoice_number: 5, client_name_raw: 'Ana', issue_date: '2026-06-10', paid_usd: 32.5 }, [
          { freight_type: 'AIR', total: 32.5, profit: 10, freight_cost: 22.5, unit_price: 6.5, quantity_lbs: 5 },
        ]),
    } as unknown as BillingRepository
    const r = await new BillingService(repo).publicReceipt('tok')
    expect(r).not.toBeNull()
    expect(r!.total).toBe(32.5)
    expect(r!.invoiceNumber).toBe(5)
    const line = r!.lines[0] as Record<string, unknown>
    expect(line).not.toHaveProperty('profit')
    expect(line).not.toHaveProperty('freightCost')
    expect(line.total).toBe(32.5)
  })
})

describe('aggregateYear', () => {
  it('buckets revenue by month + freight, tracks receivables, skips VOID', () => {
    const r = aggregateYear(2026, [
      bundle({ status: 'PAID', issue_date: '2026-01-15', total: 32.5, paid_usd: 32.5 }, [{ freight_type: 'AIR', total: 32.5, profit: 10, quantity_lbs: 5 }]),
      bundle({ status: 'ISSUED', issue_date: '2026-03-02', total: 20, paid_usd: 0 }, [{ freight_type: 'MAR', total: 20, profit: 8, quantity_lbs: 8 }]),
      bundle({ status: 'VOID', issue_date: '2026-03-05', total: 99 }, [{ freight_type: 'AIR', total: 99, profit: 50, quantity_lbs: 9 }]),
    ])
    expect(r.invoices).toBe(2)
    expect(r.revenue).toBe(52.5)
    expect(r.receivables).toBe(20)
    expect(r.byMonth[0]).toEqual({ month: 1, revenue: 32.5, profit: 10, invoices: 1 })
    expect(r.byMonth[2]).toEqual({ month: 3, revenue: 20, profit: 8, invoices: 1 })
    expect(r.byFreight.AIR.revenue).toBe(32.5)
  })
})

describe('createInvoice — package links', () => {
  function repoForPackages(belongs: boolean) {
    const bundle: InvoiceBundle = {
      header: {
        id: 'i1', invoice_number: 1, fiscal_year: 2026, client_id: null, client_name_raw: 'Ana',
        issue_date: '2026-09-05', status: 'ISSUED', address: null, special_price: false, observations: null,
        tracking_orders: [], agent_id: null, created_at: '', updated_at: '', total: 7, profit: 2.5, paid_usd: 0,
      } as InvoiceBundle['header'],
      lines: [{ id: 'l1', invoice_id: 'i1', line_no: 1, description: null, freight_type: 'AIR', quantity_lbs: 1, unit: 'lbs', unit_price: 7, total: 7, list_price: null, freight_cost: 4.5, profit: 2.5, price_tier: 'REGULAR', price_off_catalog: false }] as InvoiceBundle['lines'],
      payments: [],
      packages: [{ id: 'lk1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null }],
    }
    const insertPackageEvent = vi.fn(async () => {})
    const repo = {
      getOrgRates: async () => [{ id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5 }] }],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      packageBelongsToOrg: async () => belongs,
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader: async () => 'i1',
      insertLineItems: async () => {},
      linkPackage: async () => {},
      insertInvoiceEvent: vi.fn(async () => {}),
      insertPackageEvent,
      insertInvoiceEvent: vi.fn(async () => {}),
      getInvoiceBundle: async () => bundle,
    } as unknown as BillingRepository
    return { repo, insertPackageEvent }
  }

  it('rejects a package that does not belong to the agency (no writes)', async () => {
    const { repo, insertPackageEvent } = repoForPackages(false)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/not found in your agency/)
    expect(insertPackageEvent).not.toHaveBeenCalled()
  })

  it('stamps the package history with the invoice number on success', async () => {
    const { repo, insertPackageEvent } = repoForPackages(true)
    const svc = new BillingService(repo)
    await svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue')
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-1', 'Factura #1 generada', expect.any(String))
  })
})

describe('createInvoice — other charges', () => {
  function repoWithConcept(conceptInOrg: boolean) {
    const bundle: InvoiceBundle = {
      header: {
        id: 'i1', invoice_number: 1, fiscal_year: 2026, client_id: null, client_name_raw: 'Ana',
        issue_date: '2026-09-05', status: 'ISSUED', address: null, special_price: false, observations: null,
        tracking_orders: [], agent_id: null, created_at: '', updated_at: '', total: 10, profit: 5.5, paid_usd: 0,
      } as InvoiceBundle['header'],
      lines: [{ id: 'l1', invoice_id: 'i1', line_no: 1, description: null, freight_type: 'AIR', quantity_lbs: 1, unit: 'lbs', unit_price: 7, total: 7, list_price: null, freight_cost: 4.5, profit: 2.5, price_tier: 'REGULAR', price_off_catalog: false }] as InvoiceBundle['lines'],
      payments: [],
      packages: [],
    }
    const insertLineItems = vi.fn(async () => {})
    const repo = {
      getOrgRates: async () => [{ id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5 }] }],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      conceptBelongsToOrg: async () => conceptInOrg,
      getChargeConcept: async () => ({ id: 'cc1', name: 'Delivery' }),
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader: async () => 'i1',
      insertLineItems,
      linkPackage: async () => {},
      insertInvoiceEvent: vi.fn(async () => {}),
      getInvoiceBundle: async () => bundle,
    } as unknown as BillingRepository
    return { repo, insertLineItems }
  }

  it('rejects other charges with a non-positive amount', async () => {
    const { repo } = repoWithConcept(true)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], otherLines: [{ conceptId: 'cc1', amount: 0 }] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/positive amount/)
  })

  it('rejects a concept from another agency', async () => {
    const { repo } = repoWithConcept(false)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], otherLines: [{ conceptId: 'cc1', amount: 3 }] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/not found in your agency/)
  })

  it('composes the description from the concept name and adds the amount to the totals', async () => {
    const { repo, insertLineItems } = repoWithConcept(true)
    const svc = new BillingService(repo)
    await svc.createInvoice(
      { clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], otherLines: [{ conceptId: 'cc1', description: 'zona norte', amount: 3 }] },
      'tester',
      'solo-guegue',
    )
    const rows = insertLineItems.mock.calls[0][1] as Record<string, unknown>[]
    const other = rows.find((r) => r.line_type === 'other')
    expect(other).toMatchObject({ description: 'Delivery — zona norte', unit_price: 3, total: 3, profit: 3, freight_cost: 0, quantity_lbs: null, concept_id: 'cc1' })
  })
})

// ─── Financial lock (bulk-invoicing-foundation) ───────────────────────────────

function lockRepo(headerOver: Partial<InvoiceBundle['header']> = {}, closeWins = true) {
  const b = bundle({ status: 'DRAFT', total: 40, closed_at: null, closed_by: null, ...headerOver } as Partial<InvoiceBundle['header']>, [
    { total: 32.5, profit: 10 },
    { total: 7.5, profit: 3 },
  ])
  const closeInvoiceIfOpen = vi.fn(async () => closeWins)
  const setInvoiceStatus = vi.fn(async () => {})
  const insertInvoiceEvent = vi.fn(async () => {})
  const linkPackage = vi.fn(async () => {})
  const unlinkPackage = vi.fn(async () => {})
  const insertPayment = vi.fn(async () => {})
  const repo = {
    getInvoiceBundle: async () => b,
    get: async () => toView(b),
    setInvoiceStatus,
    closeInvoiceIfOpen,
    insertInvoiceEvent,
    linkPackage,
    unlinkPackage,
    insertPayment,
    setInvoiceTotals: async () => {},
  } as unknown as BillingRepository
  return { repo, b, setInvoiceStatus, closeInvoiceIfOpen, insertInvoiceEvent, linkPackage, unlinkPackage, insertPayment }
}

describe('closeInvoice — financial lock', () => {
  it('closes an open DRAFT, promoting it to ISSUED with actor + event', async () => {
    const { repo, closeInvoiceIfOpen, insertInvoiceEvent } = lockRepo()
    const svc = new BillingService(repo)
    await svc.closeInvoice('i1', 'hit', 'ana@hit.com')
    expect(closeInvoiceIfOpen).toHaveBeenCalledWith('i1', 'hit', 'DRAFT', 'ISSUED', expect.stringMatching(/^\d{4}-/), 'ana@hit.com')
    expect(insertInvoiceEvent).toHaveBeenCalledWith('i1', 'hit', 'Factura cerrada', 'Total fijado en 40.00 USD', 'ana@hit.com')
  })
  it('fails cleanly when the compare-and-set loses to a concurrent close/void', async () => {
    const { repo, insertInvoiceEvent } = lockRepo({}, false)
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/already closed or voided/)
    expect(insertInvoiceEvent).not.toHaveBeenCalled()
  })
  it('rejects closing twice', async () => {
    const { repo, closeInvoiceIfOpen } = lockRepo({ closed_at: '2026-09-01T00:00:00Z', closed_by: 'x@y.z' })
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/already closed/)
    expect(closeInvoiceIfOpen).not.toHaveBeenCalled()
  })
  it('rejects closing a VOID invoice', async () => {
    const { repo } = lockRepo({ status: 'VOID' })
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/voided/)
  })
})

describe('payment + link guards vs the lock', () => {
  it('blocks payments while the invoice is open', async () => {
    const { repo, insertPayment } = lockRepo({ status: 'ISSUED' })
    await expect(
      new BillingService(repo).applyPayment('i1', { method: 'CASH', currency: 'USD', amount: 5 }, 'hit', 'a@b.c'),
    ).rejects.toThrow(/Close the invoice before recording payments/)
    expect(insertPayment).not.toHaveBeenCalled()
  })
  it('allows payments once closed (legacy with money was backfilled closed)', async () => {
    const { repo, insertPayment } = lockRepo({ status: 'ISSUED', closed_at: '2026-09-01T00:00:00Z', closed_by: 'system:bulk-invoicing-backfill' })
    await new BillingService(repo).applyPayment('i1', { method: 'CASH', currency: 'USD', amount: 5 }, 'hit', 'a@b.c')
    expect(insertPayment).toHaveBeenCalled()
  })
  it('freezes package links after closing', async () => {
    const { repo, linkPackage, unlinkPackage } = lockRepo({ closed_at: '2026-09-01T00:00:00Z' })
    const svc = new BillingService(repo)
    await expect(svc.linkPackage('i1', 'pkg-1', 'a@b.c', 'hit')).rejects.toThrow(/links are frozen/)
    await expect(svc.unlinkPackage('i1', 'pkg-1', 'hit')).rejects.toThrow(/links are frozen/)
    expect(linkPackage).not.toHaveBeenCalled()
    expect(unlinkPackage).not.toHaveBeenCalled()
  })
  it('rejects a package from another agency on manual link (tenant pin)', async () => {
    const { repo } = lockRepo()
    const withPin = {
      ...repo,
      packageBelongsToOrg: async () => false,
    } as unknown as BillingRepository
    await expect(new BillingService(withPin).linkPackage('i1', 'pkg-1', 'a@b.c', 'hit')).rejects.toThrow(/not found in your agency/)
  })
})

describe('createInvoice — initial lock state', () => {
  function captureHeader() {
    const createInvoiceHeader = vi.fn(async () => 'i1')
    const repo = {
      getOrgRates: async () => [{ id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5 }] }],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader,
      insertLineItems: async () => {},
      insertInvoiceEvent: async () => {},
      getInvoiceBundle: async () => bundle({}),
    } as unknown as BillingRepository
    return { repo, createInvoiceHeader }
  }
  const input = { clientName: 'Ana', lines: [{ freightType: 'AIR' as const, tier: 'REGULAR', quantityLbs: 1 }] }

  it('auto-closes an ISSUED invoice at creation (panel "Nueva factura" keeps paying)', async () => {
    const { repo, createInvoiceHeader } = captureHeader()
    await new BillingService(repo).createInvoice(input, 'ana@hit.com', 'hit')
    const row = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(row.status).toBe('ISSUED')
    expect(row.closed_at).toMatch(/^\d{4}-/)
    expect(row.closed_by).toBe('ana@hit.com')
  })
  it('leaves an explicit DRAFT open until closeInvoice', async () => {
    const { repo, createInvoiceHeader } = captureHeader()
    await new BillingService(repo).createInvoice({ ...input, status: 'DRAFT' }, 'ana@hit.com', 'hit')
    const row = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(row.status).toBe('DRAFT')
    expect(row.closed_at).toBeNull()
    expect(row.closed_by).toBeNull()
  })
  it('clamps a client-fabricated money status (PAID) to ISSUED — money state is derived, never asserted', async () => {
    const { repo, createInvoiceHeader } = captureHeader()
    await new BillingService(repo).createInvoice({ ...input, status: 'PAID' }, 'ana@hit.com', 'hit')
    const row = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(row.status).toBe('ISSUED')
    expect(row.paid_usd).toBe(0)
  })
})
