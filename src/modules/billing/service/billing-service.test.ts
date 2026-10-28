import { describe, expect, it, vi } from 'vitest'
import type { InvoiceBundle } from '../repo/billing-repo.js'
import type { BillingRepository } from '../repo/billing-repo.js'
import { aggregateClose, aggregateYear, BillingService, computeStatus, paymentUsd, toView } from './billing-service.js'

/** Defaults for the batched link/event/guard methods added to BillingRepository.
 *  Mocks spread the repo AFTER these, so per-test overrides win. The guard
 *  default returns an empty list — create-path tests with packages override it
 *  to report every package linked (or assert the rollback). */
function withBatchedLinks<T extends object>(repo: T) {
  return {
    getActivePackageLinks: async () => new Map<string, string>(),
    listActiveLinkedPackageIds: async () => [] as string[],
    linkPackages: vi.fn(async () => {}),
    insertPackageEvents: vi.fn(async () => {}),
    insertAuditLog: async () => {},
    ...repo,
  }
}

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

  it('flags the integrity warning when a billed package has no active link', () => {
    const b = bundle({ status: 'ISSUED' }, [
      { line_type: 'freight', package_id: 'pkg-1' },
      { line_type: 'freight', package_id: 'pkg-2' },
    ])
    b.packages = [
      { id: 'lk1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null, active: true },
      { id: 'lk2', invoice_id: 'i1', package_id: 'pkg-2', source: 'manual', matched_oc: null, active: false },
    ] as InvoiceBundle['packages']
    const v = toView(b)
    expect(v.integrityWarning).toBe(true)
  })

  it('no warning when every billed package has an active link', () => {
    const b = bundle({ status: 'ISSUED' }, [{ line_type: 'freight', package_id: 'pkg-1' }])
    b.packages = [{ id: 'lk1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null, active: true }] as InvoiceBundle['packages']
    expect(toView(b).integrityWarning).toBe(false)
  })

  it('no warning on VOID invoices — released links are by design', () => {
    const b = bundle({ status: 'VOID' }, [{ line_type: 'freight', package_id: 'pkg-1' }])
    b.packages = [{ id: 'lk1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null, active: false }] as InvoiceBundle['packages']
    expect(toView(b).integrityWarning).toBeNull()
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
        bundle({ status: 'PAID', invoice_number: 5, client_name_raw: 'Ana', issue_date: '2026-06-10', paid_usd: 32.5, organization_id: 'hit' }, [
          { freight_type: 'AIR', total: 32.5, profit: 10, freight_cost: 22.5, unit_price: 6.5, quantity_lbs: 5 },
        ]),
      getAgencyInfo: async () => ({ name: 'HIT Cargo', logoUrl: null, ruc: null, address: null, phone: null }),
    } as unknown as BillingRepository
    const r = await new BillingService(repo).publicReceipt('tok')
    expect(r).not.toBeNull()
    expect(r!.total).toBe(32.5)
    expect(r!.invoiceNumber).toBe(5)
    expect(r!.agency.name).toBe('HIT Cargo')
    expect(r!.agency.exchangeRateNioPerUsd).toBeNull()
    const line = r!.lines[0] as Record<string, unknown>
    expect(line).not.toHaveProperty('profit')
    expect(line).not.toHaveProperty('freightCost')
    expect(line.total).toBe(32.5)
  })

  it('resolves legacy freight lines from linked packages in line order', async () => {
    const b = bundle({ status: 'ISSUED', organization_id: 'solo-guegue' }, [
      { line_no: 1, line_type: 'freight', package_id: null, package_guia: null, package_tracking: null },
      { line_no: 2, line_type: 'freight', package_id: null, package_guia: null, package_tracking: null },
    ])
    b.packages = [
      { id: 'link-1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null, packages: { almacen_id: 'SG-100111', tracking_number: 'TRACK-111' } },
      { id: 'link-2', invoice_id: 'i1', package_id: 'pkg-2', source: 'manual', matched_oc: null, packages: { almacen_id: 'SG-100106', tracking_number: 'TRACK-106' } },
    ]
    const repo = {
      getPublicBundle: async () => b,
      getAgencyInfo: async () => ({ name: 'Solo Guegue', logoUrl: null, ruc: null, address: null, phone: null }),
    } as unknown as BillingRepository

    const receipt = await new BillingService(repo).publicReceipt('tok')

    expect(receipt?.lines.map((line) => [line.guia, line.tracking])).toEqual([
      ['SG-100111', 'TRACK-111'],
      ['SG-100106', 'TRACK-106'],
    ])
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
  function repoForPackages(belongs: boolean, clientActive = true) {
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
    const insertPackageEvents = vi.fn(async () => {})
    const linkPackages = vi.fn(async () => {})
    const releasePackageLinksByInvoice = vi.fn(async () => {})
    const setInvoiceArchived = vi.fn(async () => {})
    const insertAuditLog = vi.fn(async () => {})
    const repo = {
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getClientLifecycle: async () => clientActive,
      getClientForBilling: async () => ({ id: 'c1', name: 'Ana', active: clientActive, default_rate_card_id: null, default_rate_id: null }),
      listClientsForBilling: async () => [{ id: 'c1', name: 'Ana', active: clientActive, default_rate_card_id: null, default_rate_id: null }],
      getActivePackageLink: async () => null,
      getActivePackageLinks: async () => new Map<string, string>(),
      getPackagesForBulk: async (ids: string[]) =>
        belongs
          ? ids.map((id) => ({ id, almacen_id: `G-${id}`, tracking_number: `T-${id}`, effective_status: 'entregado', service_type: 'aereo', weight_lb: 5, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' }))
          : [],
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader: async () => 'i1',
      insertLineItems: vi.fn(async () => {}),
      linkPackages,
      insertPackageEvents,
      insertAuditLog,
      insertInvoiceEvent: vi.fn(async () => {}),
      getInvoiceBundle: async () => bundle,
      listActiveLinkedPackageIds: async () => ['pkg-1'],
      releasePackageLinksByInvoice,
      setInvoiceArchived,
    } as unknown as BillingRepository
    return { repo, insertPackageEvents, linkPackages, insertAuditLog, releasePackageLinksByInvoice, setInvoiceArchived }
  }

  it('rejects a package that does not belong to the agency (no writes)', async () => {
    const { repo, insertPackageEvents } = repoForPackages(false)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/no existe en tu agencia/)
    expect(insertPackageEvents).not.toHaveBeenCalled()
  })

  it('stamps the package history with the invoice number on success', async () => {
    const { repo, insertPackageEvents } = repoForPackages(true)
    const svc = new BillingService(repo)
    await svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue')
    expect(insertPackageEvents).toHaveBeenCalledWith([{ packageId: 'pkg-1', description: 'Factura #1 generada', occurredAt: expect.any(String) }])
  })

  it('snapshots guía/tracking into the line when the freight line carries a packageId', async () => {
    const { repo } = repoForPackages(true)
    const insertLineItems = repo.insertLineItems as ReturnType<typeof vi.fn>
    const svc = new BillingService(repo)
    await svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-1' }] }, 'tester', 'solo-guegue')
    const row = insertLineItems.mock.calls[0][1][0] as Record<string, unknown>
    expect(row.package_id).toBe('pkg-1')
    expect(row.package_guia).toBe('G-pkg-1')
    expect(row.package_tracking).toBe('T-pkg-1')
  })

  it('rejects invoicing for a deactivated client', async () => {
    const { repo } = repoForPackages(true, false)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/desactivado/)
  })

  it('reverts the whole invoice when linking fails (rollback: release + archive + audit, 422 envelope)', async () => {
    const { repo, linkPackages, releasePackageLinksByInvoice, setInvoiceArchived, insertAuditLog } = repoForPackages(true)
    linkPackages.mockRejectedValueOnce(new Error('fetch failed: subrequest limit'))
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue'),
    ).rejects.toMatchObject({ code: 'INVOICE_CREATION_REVERTED', status: 422 })
    // Compensating actions: links released (package back to billable) and the
    // ghost header archived, never left blocking reports half-invoiced.
    expect(releasePackageLinksByInvoice).toHaveBeenCalledWith('i1', 'system:creation-failed')
    expect(setInvoiceArchived).toHaveBeenCalledWith('i1', 'solo-guegue', 'system:creation-failed', expect.stringMatching(/revertida automáticamente \(F-/))
    expect(insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.create_failed', entityId: 'i1', metadata: expect.objectContaining({ support_code: expect.stringMatching(/^F-[0-9A-F]{8}$/) }) }))
  })

  it('reverts when the integrity guard finds fewer active links than packages billed', async () => {
    const { repo, releasePackageLinksByInvoice, setInvoiceArchived } = repoForPackages(true)
    // Guard reads back the links; simulate one link lost (budget died midway in prod).
    ;(repo.listActiveLinkedPackageIds as (id: string) => Promise<string[]>) = async () => []
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue'),
    ).rejects.toMatchObject({ code: 'INVOICE_CREATION_REVERTED' })
    expect(releasePackageLinksByInvoice).toHaveBeenCalled()
    expect(setInvoiceArchived).toHaveBeenCalled()
  })

  it('keeps the invoice when the guard confirms every package linked', async () => {
    const { repo, setInvoiceArchived } = repoForPackages(true)
    const svc = new BillingService(repo)
    const view = await svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], packageIds: ['pkg-1'] }, 'tester', 'solo-guegue')
    expect(view.invoiceNumber).toBe(1)
    expect(setInvoiceArchived).not.toHaveBeenCalled()
  })
})

describe('listUnbilledPackagesForClient', () => {
  it('marks eligible + ineligible packages with reasons', async () => {
    const repo = {
      getPackagesForClient: async () => [
        { id: 'p1', almacen_id: 'SG-1', tracking_number: 'T1', effective_status: 'entregado', service_type: 'aereo', weight_lb: 3, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' },
        { id: 'p2', almacen_id: 'SG-2', tracking_number: 'T2', effective_status: 'en_almacen', service_type: 'aereo', weight_lb: 3, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' },
        { id: 'p3', almacen_id: 'SG-3', tracking_number: null, effective_status: 'entregado', service_type: 'aereo', weight_lb: null, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' },
      ],
      getActivePackageLink: async (id: string) => (id === 'p1' ? { invoiceId: 'i9' } : null),
      getActivePackageLinks: async (ids: string[]) => (ids.includes('p1') ? new Map([['p1', 'i9']]) : new Map()),
    } as unknown as BillingRepository
    const res = await new BillingService(repo).listUnbilledPackagesForClient('c1', 'solo-guegue')
    expect(res.packages.map((p) => [p.guia, p.eligible, p.reason])).toEqual([
      ['SG-1', false, 'Ya facturado'],
      ['SG-2', false, 'Estado en_almacen no facturable'],
      ['SG-3', false, 'Sin peso'],
    ])
  })
})

describe('updateInvoice — package link sync', () => {
  it('links new packages and releases removed ones while the draft stays open', async () => {
    const bundleWithLinks: InvoiceBundle = bundle({ status: 'DRAFT', client_id: 'c1', client_name_raw: 'Ana' }, [
      { line_no: 1, freight_type: 'AIR', package_id: 'pkg-a', package_guia: 'G-A', package_tracking: 'T-A' },
    ])
    bundleWithLinks.packages = [
      { id: 'lk1', invoice_id: 'i1', package_id: 'pkg-a', source: 'manual', matched_oc: 'G-A', active: true },
    ]
    const linkPackage = vi.fn(async () => {})
    const unlinkPackage = vi.fn(async () => {})
    const insertPackageEvent = vi.fn(async () => {})
    const insertInvoiceEvent = vi.fn(async () => {})
    const repo = {
      getInvoiceBundle: async () => bundleWithLinks,
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getActivePackageLink: async () => null,
      getActivePackageLinks: async () => new Map<string, string>(),
      getPackagesForBulk: async (ids: string[]) =>
        ids.map((id) => ({ id, almacen_id: `G-${id}`, tracking_number: `T-${id}`, effective_status: 'entregado', service_type: 'aereo', weight_lb: 5, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' })),
      replaceLineItems: async () => {},
      linkPackage,
      unlinkPackage,
      insertPackageEvent,
      insertInvoiceEvent,
      patchInvoiceHeader: async () => {},
      get: async () => bundleWithLinks,
    } as unknown as BillingRepository
    const svc = new BillingService(repo)
    await svc.updateInvoice(
      'i1',
      {
        lines: [
          { freightType: 'AIR', tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-b' },
          { freightType: 'MAR', tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-a' },
        ],
      },
      'tester',
      'solo-guegue',
    )
    expect(linkPackage).toHaveBeenCalledWith('i1', 'pkg-b', 'manual', 'G-pkg-b', 'tester', 'solo-guegue')
    expect(unlinkPackage).not.toHaveBeenCalled()
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-b', 'Factura #1 enlazada', expect.any(String))
  })

  it('releases packages removed from the edited draft and logs the unlink', async () => {
    const bundleWithLinks: InvoiceBundle = bundle({ status: 'DRAFT', client_id: 'c1', client_name_raw: 'Ana' }, [
      { line_no: 1, freight_type: 'AIR', package_id: 'pkg-a' },
      { line_no: 2, freight_type: 'MAR', package_id: 'pkg-b' },
    ])
    bundleWithLinks.packages = [
      { id: 'lk1', invoice_id: 'i1', package_id: 'pkg-a', source: 'manual', matched_oc: 'G-A', active: true },
      { id: 'lk2', invoice_id: 'i1', package_id: 'pkg-b', source: 'manual', matched_oc: 'G-B', active: true },
    ]
    const linkPackage = vi.fn(async () => {})
    const unlinkPackage = vi.fn(async () => {})
    const insertPackageEvent = vi.fn(async () => {})
    const insertInvoiceEvent = vi.fn(async () => {})
    const repo = {
      getInvoiceBundle: async () => bundleWithLinks,
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getActivePackageLink: async () => null,
      getActivePackageLinks: async () => new Map<string, string>(),
      getPackagesForBulk: async (ids: string[]) =>
        ids.map((id) => ({ id, almacen_id: `G-${id}`, tracking_number: `T-${id}`, effective_status: 'entregado', service_type: 'aereo', weight_lb: 5, client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue' })),
      replaceLineItems: async () => {},
      linkPackage,
      unlinkPackage,
      insertPackageEvent,
      insertInvoiceEvent,
      patchInvoiceHeader: async () => {},
      get: async () => bundleWithLinks,
    } as unknown as BillingRepository
    const svc = new BillingService(repo)
    await svc.updateInvoice('i1', { lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-a' }] }, 'tester', 'solo-guegue')
    expect(unlinkPackage).toHaveBeenCalledWith('i1', 'pkg-b')
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-b', 'Factura #1 desenlazada', expect.any(String))
    expect(insertInvoiceEvent).toHaveBeenCalledWith('i1', 'solo-guegue', 'Paquete desenlazado', 'pkg-b', 'tester')
  })
})

describe('invoice package events on lifecycle', () => {
  it('logs close/void/payment events onto each active linked package', async () => {
    const withPkgs = (status: 'DRAFT' | 'ISSUED', closed = false) => {
      const b = bundle({ status, client_name_raw: 'Ana', closed_at: closed ? '2026-09-05' : null }, [{ line_no: 1, freight_type: 'AIR', total: 10 }])
      b.packages = [{ id: 'lk1', invoice_id: 'i1', package_id: 'pkg-a', source: 'manual', matched_oc: 'G-A', active: true }]
      return b
    }
    const insertPackageEvent = vi.fn(async () => {})
    let current = withPkgs('DRAFT')
    const repo = {
      getInvoiceBundle: async () => current,
      closeInvoiceIfOpen: async () => true,
      insertInvoiceEvent: async () => {},
      insertPackageEvent,
      setInvoiceStatus: async () => {},
      setInvoiceTotals: async () => {},
      releasePackageLinksByInvoice: async () => {},
      insertPayment: async () => {},
      get: async () => current,
    } as unknown as BillingRepository
    const svc = new BillingService(repo)

    await svc.closeInvoice('i1', 'solo-guegue', 'tester')
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-a', 'Factura #1 cerrada', expect.any(String))

    insertPackageEvent.mockClear()
    current = withPkgs('ISSUED', true)
    await svc.applyPayment('i1', { method: 'CASH', currency: 'USD', amount: 5 }, 'solo-guegue', 'tester')
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-a', 'Pago parcial de factura #1', expect.any(String))

    insertPackageEvent.mockClear()
    current = withPkgs('ISSUED', true)
    await svc.voidInvoice('i1', 'razón', 'solo-guegue')
    expect(insertPackageEvent).toHaveBeenCalledWith('pkg-a', 'Factura #1 anulada', expect.any(String))
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
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getClientLifecycle: async () => true,
      getClientForBilling: async () => ({ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }),
      listClientsForBilling: async () => [{ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }],
      conceptBelongsToOrg: async () => conceptInOrg,
      getChargeConcept: async () => ({ id: 'cc1', name: 'Delivery' }),
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader: async () => 'i1',
      insertLineItems,
      linkPackages: async () => {},
      insertPackageEvents: async () => {},
      insertAuditLog: async () => {},
      listActiveLinkedPackageIds: async () => [],
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
    ).rejects.toThrow(/monto mayor a cero/)
  })

  it('rejects a concept from another agency', async () => {
    const { repo } = repoWithConcept(false)
    const svc = new BillingService(repo)
    await expect(
      svc.createInvoice({ clientName: 'Ana', lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 1 }], otherLines: [{ conceptId: 'cc1', amount: 3 }] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/no existe en tu agencia/)
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
  const releasePackageLinksByInvoice = vi.fn(async () => {})
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
    getActivePackageLink: async () => null,
    packageBelongsToOrg: async () => true,
    releasePackageLinksByInvoice,
  } as unknown as BillingRepository
  return { repo, b, setInvoiceStatus, closeInvoiceIfOpen, insertInvoiceEvent, linkPackage, unlinkPackage, insertPayment, releasePackageLinksByInvoice }
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
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/ya fue cerrada o anulada/)
    expect(insertInvoiceEvent).not.toHaveBeenCalled()
  })
  it('rejects closing twice', async () => {
    const { repo, closeInvoiceIfOpen } = lockRepo({ closed_at: '2026-09-01T00:00:00Z', closed_by: 'x@y.z' })
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/ya está cerrada/)
    expect(closeInvoiceIfOpen).not.toHaveBeenCalled()
  })
  it('rejects closing a VOID invoice', async () => {
    const { repo } = lockRepo({ status: 'VOID' })
    await expect(new BillingService(repo).closeInvoice('i1', 'hit', 'a@b.c')).rejects.toThrow(/anulada/)
  })
})

describe('payment + link guards vs the lock', () => {
  it('blocks payments while the invoice is open', async () => {
    const { repo, insertPayment } = lockRepo({ status: 'ISSUED' })
    await expect(
      new BillingService(repo).applyPayment('i1', { method: 'CASH', currency: 'USD', amount: 5 }, 'hit', 'a@b.c'),
    ).rejects.toThrow(/Cierra la factura antes de registrar pagos/)
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
    await expect(svc.linkPackage('i1', 'pkg-1', 'a@b.c', 'hit')).rejects.toThrow(/vínculos de paquetes están congelados/)
    await expect(svc.unlinkPackage('i1', 'pkg-1', 'hit')).rejects.toThrow(/vínculos de paquetes están congelados/)
    expect(linkPackage).not.toHaveBeenCalled()
    expect(unlinkPackage).not.toHaveBeenCalled()
  })
  it('rejects a package from another agency on manual link (tenant pin)', async () => {
    const { repo } = lockRepo()
    const withPin = {
      ...repo,
      packageBelongsToOrg: async () => false,
    } as unknown as BillingRepository
    await expect(new BillingService(withPin).linkPackage('i1', 'pkg-1', 'a@b.c', 'hit')).rejects.toThrow(/no existe en tu agencia/)
  })
})

describe('createInvoice — initial lock state', () => {
  function captureHeader() {
    const createInvoiceHeader = vi.fn(async () => 'i1')
    const repo = {
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      upsertClient: async () => 'c1',
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getClientLifecycle: async () => true,
      getClientForBilling: async () => ({ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }),
      listClientsForBilling: async () => [{ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }],
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader,
      insertLineItems: async () => {},
      linkPackages: async () => {},
      insertPackageEvents: async () => {},
      insertAuditLog: async () => {},
      listActiveLinkedPackageIds: async () => [],
      insertInvoiceEvent: async () => {},
      getInvoiceBundle: async () => bundle({}),
      getActivePackageLink: async () => null,
      getActivePackageLinks: async () => new Map(),
      packageBelongsToOrg: async () => true,
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

// ─── Bulk invoicing (from Paquetería) ────────────────────────────────────────

function bulkRepo(pkgs: Array<{ id: string; almacen_id: string; effective_status: string; service_type: string | null; weight_lb: number | null; client_id: string | null; referencia_name: string | null }>, defaultRateTableId: string | null = null, activeLinks: Record<string, string> = {}) {
  const insertLineItems = vi.fn(async () => {})
  const insertInvoiceEvent = vi.fn(async () => {})
  const insertPackageEvent = vi.fn(async () => {})
  const insertPackageEvents = vi.fn(async () => {})
  const linkPackage = vi.fn(async () => {})
  const linkPackages = vi.fn(async () => {})
  const createInvoiceHeader = vi.fn(async () => 'i-bulk')
  const repo = {
    getPackagesForBulk: async () => pkgs.map((p) => ({ ...p, organization_id: 'hit', tracking_number: null })),
    getClientDefaultRateTable: async () => defaultRateTableId,
    getClientDefaultRateCard: async () => null,
    getClientLifecycle: async () => true,
    getClientForBilling: async (id: string) => ({ id, name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: defaultRateTableId }),
    listClientsForBilling: async () => [{ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: defaultRateTableId }],
    getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
        { id: 't2', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 9, cost: 5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
    upsertClient: async () => 'c1',
    nextInvoiceNumber: async () => 1,
    createInvoiceHeader,
    insertLineItems,
    linkPackage,
    linkPackages,
    insertPackageEvent,
    insertPackageEvents,
    insertAuditLog: async () => {},
    insertInvoiceEvent,
    getActivePackageLink: async (packageId: string) => activeLinks[packageId] ? { invoiceId: activeLinks[packageId] } : null,
    getActivePackageLinks: async (ids: string[]) => new Map(ids.filter((id) => activeLinks[id]).map((id) => [id, activeLinks[id]])),
    listActiveLinkedPackageIds: async () => pkgs.map((p) => p.id),
    getInvoiceBundle: async () => ({
      header: { id: 'i-bulk', invoice_number: 1, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Test', issue_date: '2026-09-06', status: 'DRAFT', address: null, special_price: false, observations: null, tracking_orders: [], agent_id: null, public_token: null, paid_at: null, total: 14, profit: 5, paid_usd: 0, closed_at: null, closed_by: null, created_at: '', updated_at: '' },
      lines: [{ id: 'l1', invoice_id: 'i-bulk', line_no: 1, description: null, freight_type: 'AIR', quantity_lbs: 2, unit: 'lbs', unit_price: 7, total: 14, list_price: null, freight_cost: 9, profit: 5, price_tier: 'REGULAR', price_off_catalog: false, package_id: pkgs[0]?.id ?? null, package_guia: pkgs[0]?.almacen_id ?? null, package_tracking: null }],
      payments: [],
      packages: [],
    }),
  } as unknown as BillingRepository
  return { repo, insertLineItems, linkPackages, insertPackageEvents, createInvoiceHeader }
}

const enDestino = (id: string, client: string | null = 'Ana', ref: string | null = 'Ana') => ({
  id,
  almacen_id: `g${id}`,
  effective_status: 'en_destino',
  service_type: 'aereo',
  weight_lb: 2,
  client_id: client ? `c-${client}` : null,
  referencia_name: ref,
})

const entregado = (id: string) => ({ ...enDestino(id), effective_status: 'entregado' })
const enTransito = (id: string) => ({ ...enDestino(id), effective_status: 'en_transito' })

describe('previewBulkPackages — validation', () => {
  it('rejects empty selection', async () => {
    const { repo } = bulkRepo([])
    await expect(new BillingService(repo).previewBulkPackages([], 'hit')).rejects.toThrow(/No hay paquetes/)
  })
  it('rejects more than 100 packages', async () => {
    const { repo } = bulkRepo([])
    await expect(new BillingService(repo).previewBulkPackages(Array.from({ length: 101 }, (_, i) => `p${i}`), 'hit')).rejects.toThrow(/Demasiados/)
  })
  it('rejects non-invoiceable statuses (en_transito)', async () => {
    const { repo } = bulkRepo([enTransito('p1')])
    await expect(new BillingService(repo).previewBulkPackages(['p1'], 'hit')).rejects.toThrow(/facturable/)
  })
  it('rejects packages with no client (neither client_id nor referencia_name)', async () => {
    const { repo } = bulkRepo([{ ...enDestino('p1'), client_id: null, referencia_name: null }])
    await expect(new BillingService(repo).previewBulkPackages(['p1'], 'hit')).rejects.toThrow(/cliente asignado/)
  })
  it('rejects mixed clients', async () => {
    const { repo } = bulkRepo([enDestino('p1', 'Ana'), enDestino('p2', 'Luis')])
    await expect(new BillingService(repo).previewBulkPackages(['p1', 'p2'], 'hit')).rejects.toThrow(/clientes distintos/)
  })
})

describe('previewBulkPackages — pricing', () => {
  it('prices each line from the org rate table (AIR/REGULAR) and returns totals', async () => {
    const { repo } = bulkRepo([enDestino('p1'), entregado('p2')])
    const preview = await new BillingService(repo).previewBulkPackages(['p1', 'p2'], 'hit')
    expect(preview.lines).toHaveLength(2)
    expect(preview.lines[0].unitPrice).toBe(7)
    expect(preview.lines[0].total).toBe(14) // 2 lb × 7
    expect(preview.total).toBe(28)
    expect(preview.clientName).toBeTruthy()
  })
  it('uses client_id when set, falls back to referencia_name', async () => {
    const pkgs = [{ ...enDestino('p1'), client_id: 'c-ana', referencia_name: 'ANA' }]
    const { repo } = bulkRepo(pkgs)
    const preview = await new BillingService(repo).previewBulkPackages(['p1'], 'hit')
    expect(preview.clientId).toBe('c-ana')
    expect(preview.clientName).toBe('ANA')
  })
  it('uses referencia_name when client_id is null', async () => {
    const pkgs = [{ ...enDestino('p1'), client_id: null, referencia_name: 'Luis' }]
    const { repo } = bulkRepo(pkgs)
    const preview = await new BillingService(repo).previewBulkPackages(['p1'], 'hit')
    expect(preview.clientId).toBeNull()
    expect(preview.clientName).toBe('Luis')
  })
})

describe('createBulkInvoice', () => {
  it('creates a DRAFT invoice with one line per package and links every package', async () => {
    const { repo, insertLineItems, linkPackages, insertPackageEvents, createInvoiceHeader } = bulkRepo([enDestino('p1'), entregado('p2')])
    const svc = new BillingService(repo)
    const view = await svc.createBulkInvoice({ packageIds: ['p1', 'p2'] }, 'admin@hit.com', 'hit')
    expect(view.status).toBe('DRAFT')
    expect(view.closedAt).toBeNull()
    expect(createInvoiceHeader).toHaveBeenCalled()
    const header = createInvoiceHeader.mock.calls[0][0]
    expect(header.status).toBe('DRAFT')
    expect(header.closed_at).toBeNull()
    // Two line rows written
    const rows = insertLineItems.mock.calls[0][1]
    expect(rows).toHaveLength(2)
    expect(rows[0].package_id).toBe('p1')
    expect(rows[0].package_guia).toBe('gp1')
    expect(rows[0].package_tracking).toBeNull()
    // Both packages linked in one batched post
    expect(linkPackages).toHaveBeenCalledTimes(1)
    expect((linkPackages.mock.calls[0][1] as unknown[]).length).toBe(2)
    expect(insertPackageEvents).toHaveBeenCalledTimes(1)
  })
})

describe('linkedPackageIds', () => {
  it('returns org-scoped package IDs from the repo', async () => {
    const repo = { listLinkedPackageIds: vi.fn(async () => ['p1', 'p2', 'p1']) } as unknown as BillingRepository
    const ids = await new BillingService(repo).linkedPackageIds('hit')
    expect(repo.listLinkedPackageIds).toHaveBeenCalledWith('hit')
    // dedup handled by the repo (Set in the impl), but the service passes through
    expect(ids).toEqual(['p1', 'p2', 'p1'])
  })
})

// ─── Client resolution + the client's default rate (individual invoice) ──────

describe('createInvoice — client + default rate', () => {
  const ana: import('../repo/billing-repo.js').BillingClientRow = {
    id: 'c-ana', name: 'María José', active: true, default_rate_card_id: 'card-orig', default_rate_id: null,
  }

  function repoFor(clientName: string, opts: {
    clientRow?: import('../repo/billing-repo.js').BillingClientRow | null
    clients?: import('../repo/billing-repo.js').BillingClientRow[]
    packageClientId?: string | null
    referencia?: string | null
    cardPrice?: number
  } = {}) {
    const upsertClient = vi.fn(async () => 'created-by-name')
    const createInvoiceHeader = vi.fn(async () => 'i1')
    const insertLineItems = vi.fn(async () => {})
    const repo = {
      getOrgRateCards: async () => [{
        id: 'card-orig', name: 'Original Express', priceModel: 'weight', currency: 'USD', versionId: 'v1',
        entries: [{ id: 'e1', serviceType: 'AIR', name: 'REGULAR', unit: 'lb', price: opts.cardPrice ?? 12, cost: 6 }],
      }],
      getOrgRates: async () => [],
      getCatalog: async () => [{ freightType: 'AIR', cost: 3, tiers: { REGULAR: 5 } }],
      getClientForBilling: async (id: string, org: string) =>
        opts.clientRow && opts.clientRow.id === id && org === 'solo-guegue' ? opts.clientRow : null,
      listClientsForBilling: async (org: string) => (org === 'solo-guegue' ? (opts.clients ?? []) : []),
      upsertClient,
      getClientDefaultRateCard: async () => null,
      getClientDefaultRateTable: async () => null,
      getClientLifecycle: async () => true,
      getPackagesForBulk: async (ids: string[]) => ids.map((id) => ({
        id, almacen_id: `G-${id}`, tracking_number: null, effective_status: 'entregado',
        service_type: 'aereo', effective_service_type: 'aereo', weight_lb: 5,
        client_id: opts.packageClientId ?? null, referencia_name: opts.referencia ?? clientName,
        organization_id: 'solo-guegue',
      })),
      getActivePackageLinks: async () => new Map<string, string>(),
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader,
      insertLineItems,
      linkPackages: async () => {},
      insertPackageEvents: async () => {},
      insertAuditLog: async () => {},
      insertInvoiceEvent: async () => {},
      listActiveLinkedPackageIds: async () => ['pkg-1'],
      getInvoiceBundle: async () => bundle({ client_id: 'c-ana', client_name_raw: 'María José' }),
    } as unknown as BillingRepository
    return { repo, upsertClient, createInvoiceHeader, insertLineItems }
  }

  const line = { freightType: 'AIR' as const, tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-1' }

  it('prices with the explicit clientId default card, not the catalog, and never creates a duplicate client', async () => {
    const { repo, upsertClient, createInvoiceHeader, insertLineItems } = repoFor('ORIGINAL EXPRESS', {
      clientRow: ana, packageClientId: 'c-ana', referencia: 'ORIGINAL EXPRESS', cardPrice: 12,
    })
    await new BillingService(repo).createInvoice({ clientId: 'c-ana', clientName: 'ORIGINAL EXPRESS', lines: [line] }, 'tester', 'solo-guegue')

    expect(upsertClient).not.toHaveBeenCalled()
    const header = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(header.client_id).toBe('c-ana')
    expect(header.client_name_raw).toBe('María José')
    const row = (insertLineItems.mock.calls[0] as unknown[][])[1][0] as Record<string, unknown>
    expect(row.unit_price).toBe(12)
    expect(row.rate_card_id).toBe('card-orig')
    expect(row.pricing_source).toBe('rate_card')
  })

  it('rejects a clientId from another org instead of silently resolving by name', async () => {
    const { repo, createInvoiceHeader } = repoFor('Ana', { clientRow: null, packageClientId: 'c-ana' })
    await expect(
      new BillingService(repo).createInvoice({ clientId: 'c-foreign', clientName: 'Ana', lines: [line] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/no existe en tu agencia/)
    expect(createInvoiceHeader).not.toHaveBeenCalled()
  })

  it('rejects an explicit client that is deactivated', async () => {
    const { repo } = repoFor('Ana', { clientRow: { ...ana, active: false }, packageClientId: 'c-ana' })
    await expect(
      new BillingService(repo).createInvoice({ clientId: 'c-ana', clientName: 'Ana', lines: [line] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/desactivado/)
  })

  it('matches a legacy free-text referencia (accents/HAZMAT/case) to the existing client and its rate', async () => {
    const { repo, upsertClient, createInvoiceHeader } = repoFor('HAZMAT MARIA JOSE', {
      clients: [ana], packageClientId: null, referencia: 'HAZMAT MARIA JOSE', cardPrice: 12,
    })
    await new BillingService(repo).createInvoice({ clientName: 'HAZMAT MARIA JOSE', lines: [line] }, 'tester', 'solo-guegue')

    expect(upsertClient).not.toHaveBeenCalled()
    const header = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(header.client_id).toBe('c-ana')
    expect(header.client_name_raw).toBe('María José')
  })

  it('creates a client only when no name matches, preserving the old fallback', async () => {
    const { repo, upsertClient, createInvoiceHeader } = repoFor('Cliente Nuevo', { clients: [], packageClientId: null })
    await new BillingService(repo).createInvoice({ clientName: 'Cliente Nuevo', lines: [line] }, 'tester', 'solo-guegue')
    expect(upsertClient).toHaveBeenCalledWith('Cliente Nuevo', 'cliente nuevo', 'solo-guegue')
    const header = createInvoiceHeader.mock.calls[0][0] as Record<string, unknown>
    expect(header.client_id).toBe('created-by-name')
  })

  it('refuses to guess when several clients fuzzy-match without a configured rate', async () => {
    const duplicates = [
      { ...ana, id: 'c-ana-1', name: 'María José', default_rate_card_id: null },
      { ...ana, id: 'c-ana-2', name: 'Maria Jose', default_rate_card_id: null },
    ]
    const { repo } = repoFor('Maria Jose', { clients: duplicates, packageClientId: null, referencia: 'MARIA JOSE' })
    await expect(
      new BillingService(repo).createInvoice({ clientName: 'MARIA JOSE', lines: [line] }, 'tester', 'solo-guegue'),
    ).rejects.toThrow(/varios clientes/)
  })
})

// ─── Line row shape (PostgREST rejects heterogeneous bulk inserts) ────────────
// Incident 2026-10-28: an invoice with freight lines + an "otro cargo" sent one
// bulk POST whose objects had different keys → 400 PGRST102 "All object keys
// must match" → 500, after the edit had already deleted the existing lines.

describe('invoice line rows — uniform key set', () => {
  const keysOf = (rows: unknown[]) => rows.map((r) => Object.keys(r as object).sort().join(','))

  function repoForLines(over: Record<string, unknown> = {}) {
    const insertLineItems = vi.fn(async () => {})
    const replaceLineItems = vi.fn(async () => {})
    const setInvoiceArchived = vi.fn(async () => {})
    const bundle: InvoiceBundle = {
      header: {
        id: 'i1', invoice_number: 1, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
        issue_date: '2026-10-28', status: 'DRAFT', address: null, special_price: false, observations: null,
        tracking_orders: [], agent_id: null, created_at: '', updated_at: '', total: 0, profit: 0, paid_usd: 0,
        closed_at: null, closed_by: null,
      } as unknown as InvoiceBundle['header'],
      lines: [],
      payments: [],
      packages: [],
    }
    const repo = {
      getOrgRateCards: async () => [],
      getOrgRates: async () => [
        { id: 't1', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
      ],
      getCatalog: async () => [],
      upsertClient: async () => 'c1',
      getClientForBilling: async () => ({ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }),
      listClientsForBilling: async () => [{ id: 'c1', name: 'Ana', active: true, default_rate_card_id: null, default_rate_id: null }],
      getClientDefaultRateTable: async () => null,
      getClientDefaultRateCard: async () => null,
      getClientLifecycle: async () => true,
      getActivePackageLinks: async () => new Map<string, string>(),
      getPackagesForBulk: async (ids: string[]) => ids.map((id) => ({
        id, almacen_id: `G-${id}`, tracking_number: null, effective_status: 'entregado',
        service_type: 'aereo', effective_service_type: 'aereo', weight_lb: 2,
        client_id: 'c1', referencia_name: 'Ana', organization_id: 'solo-guegue',
      })),
      conceptBelongsToOrg: async () => true,
      getChargeConcept: async () => ({ id: 'cc1', name: 'Delivery' }),
      nextInvoiceNumber: async () => 1,
      createInvoiceHeader: async () => 'i1',
      insertLineItems,
      replaceLineItems,
      patchInvoiceHeader: async () => {},
      linkPackages: async () => {},
      linkPackage: async () => {},
      unlinkPackage: async () => {},
      insertPackageEvents: async () => {},
      insertPackageEvent: async () => {},
      insertInvoiceEvent: async () => {},
      insertAuditLog: async () => {},
      releasePackageLinksByInvoice: async () => {},
      setInvoiceArchived,
      listActiveLinkedPackageIds: async () => ['pkg-1'],
      getInvoiceBundle: async () => bundle,
      getActivePackageLink: async () => null,
      ...over,
    } as unknown as BillingRepository
    return { repo, insertLineItems, replaceLineItems, setInvoiceArchived }
  }

  const freight = { freightType: 'AIR' as const, tier: 'REGULAR', quantityLbs: 5, packageId: 'pkg-1' }
  const other = { conceptId: 'cc1', description: null, amount: 3 }

  it('createInvoice: freight + other lines share every key', async () => {
    const { repo, insertLineItems } = repoForLines()
    await new BillingService(repo).createInvoice(
      { clientName: 'Ana', lines: [freight], otherLines: [other] },
      'tester',
      'solo-guegue',
    )
    const rows = insertLineItems.mock.calls[0][1] as unknown[]
    expect(rows).toHaveLength(2)
    const [a, b] = keysOf(rows)
    expect(a).toBe(b)
    expect(a).toContain('rate_card_id')
    expect(a).toContain('package_id')
    expect(a).toContain('concept_id')
  })

  it('updateInvoice: freight + other lines share every key (the edit that used to 500)', async () => {
    const { repo, replaceLineItems } = repoForLines()
    await new BillingService(repo).updateInvoice(
      'i1',
      { lines: [freight], otherLines: [other] },
      'tester',
      'solo-guegue',
    )
    const rows = replaceLineItems.mock.calls[0][1] as unknown[]
    expect(rows).toHaveLength(2)
    const [a, b] = keysOf(rows)
    expect(a).toBe(b)
  })

  it('createInvoice: a failed line insert reverts the invoice instead of leaving a zero-line draft', async () => {
    const { repo, insertLineItems, setInvoiceArchived } = repoForLines()
    insertLineItems.mockRejectedValueOnce(new Error('InsForge POST invoice_line_items → 400'))
    await expect(
      new BillingService(repo).createInvoice({ clientName: 'Ana', lines: [freight], otherLines: [other] }, 'tester', 'solo-guegue'),
    ).rejects.toMatchObject({ code: 'INVOICE_CREATION_REVERTED', status: 422 })
    expect(setInvoiceArchived).toHaveBeenCalledWith('i1', 'solo-guegue', 'system:creation-failed', expect.stringContaining('F-'))
  })
})

describe('invoice view — pricing snapshot', () => {
  it('exposes the card that priced each line so the panel can keep it on edit', async () => {
    const bundle: InvoiceBundle = {
      header: {
        id: 'i1', invoice_number: 7, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
        issue_date: '2026-10-28', status: 'DRAFT', address: null, special_price: false, observations: null,
        tracking_orders: [], agent_id: null, created_at: '', updated_at: '', total: 27.5, profit: 8, paid_usd: 0,
        closed_at: null, closed_by: null,
      } as unknown as InvoiceBundle['header'],
      lines: [
        {
          id: 'l1', invoice_id: 'i1', line_no: 1, description: null, freight_type: 'AIR', line_type: 'freight',
          concept_id: null, quantity_lbs: 5, unit: 'lbs', unit_price: 5.5, total: 27.5, list_price: null,
          freight_cost: 22.5, profit: 5, price_tier: 'VIP', price_off_catalog: false,
          rate_card_id: 'card-vip', rate_card_version_id: 'v1', rate_card_entry_id: 'e1',
          pricing_source: 'rate_card', package_id: null, package_guia: null, package_tracking: null,
        } as unknown as InvoiceBundle['lines'][number],
      ],
      payments: [],
      packages: [],
    }
    const repo = {
      getInvoiceBundle: async () => bundle,
    } as unknown as BillingRepository
    const view = await new BillingService(repo).get('i1', 'hit')
    expect(view!.lines[0]).toMatchObject({ rateCardId: 'card-vip', pricingSource: 'rate_card', priceTier: 'VIP' })
  })
})
