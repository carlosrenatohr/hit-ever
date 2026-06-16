import { InsforgeClient } from './insforge.js'
import type { CloudflareBindings } from '../types/index.js'
import type { EventRecord, PackageRecord, Provider, ShipmentStatus } from '../types/tracking.js'

// ============================================================================
// Storage-agnostic persistence port.
// ============================================================================
// Routes/ingest depend on this interface, never on a concrete DB client. Swapping the
// database = write a new adapter and flip getRepository(); consumers don't change.
// Adapters: InsforgeClient (PostgREST-style REST) and MemoryRepository (in-memory demo).

export interface TrackingRepository {
  getPackageByGuia(guia: string): Promise<PackageRecord | null>
  getPackageByTracking(tracking: string): Promise<PackageRecord | null>
  getEvents(packageId: string): Promise<EventRecord[]>
  getActiveProviders(): Promise<Provider[]>
  upsertPackage(pkg: Record<string, unknown>): Promise<string | null>
  upsertPackages(rows: Record<string, unknown>[]): Promise<{ id: string; almacen_id: string }[]>
  upsertEvents(rows: Record<string, unknown>[]): Promise<void>
  upsertProviderNotes(rows: Record<string, unknown>[]): Promise<void>
  setManualStatus(packageId: string, status: ShipmentStatus, by: string, note?: string, at?: string): Promise<void>
  addTag(packageId: string, label: string, value: string | null, by: string): Promise<void>
  addNote(packageId: string, body: string, by: string): Promise<void>
}

// ─── Factory ──────────────────────────────────────────────────────────────────
// Picks the adapter from env. With no Insforge credentials it falls back to the in-memory
// demo repository, so `wrangler dev` serves /track from seeded data with zero external setup.
export function getRepository(env: CloudflareBindings): TrackingRepository {
  if (env.INSFORGE_API_URL && env.INSFORGE_API_KEY) {
    return new InsforgeClient(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
  }
  console.warn('[repository] INSFORGE_API_URL not set — using in-memory demo repository')
  return new MemoryRepository()
}

// ─── In-memory adapter (demo / local dev) ──────────────────────────────────────
// Seeded with sample packages derived from the real fixtures. Reads serve the seed;
// writes persist only within a single Worker isolate (fine for a demo, not for prod).
const SEED_PACKAGES: PackageRecord[] = [
  {
    id: 'demo-1',
    providerId: 'everest',
    almacenId: '926791',
    trackingNumber: '1Z2V8757YW009888714203319592612999965169581077991545',
    status: 'en_transito',
    serviceType: 'aereo',
    weightLb: 2.8,
    pieces: 1,
    originOffice: 'MIA',
    destOffice: 'MGA',
    description: 'ELECTRONICO',
    remitente: 'AMAZON',
    receivedAt: '2026-06-12T14:31:00Z',
    lastEventAt: '2026-06-12T14:31:00Z',
    scrapedAt: '2026-06-14T00:00:00Z',
  },
  {
    id: 'demo-2',
    providerId: 'global_connection',
    almacenId: '160914',
    trackingNumber: 'GFUS01055016985664',
    status: 'entregado',
    serviceType: 'aereo',
    weightLb: 1,
    pieces: 1,
    originOffice: 'MIA',
    destOffice: 'MGA',
    remitente: 'GOFO',
    receivedAt: '2026-06-10T11:09:00Z',
    lastEventAt: '2026-06-11T09:00:00Z',
    scrapedAt: '2026-06-14T00:00:00Z',
  },
]

const SEED_EVENTS: Record<string, EventRecord[]> = {
  'demo-1': [{ packageId: 'demo-1', occurredAt: '2026-06-12T14:31:00Z', office: 'MIA', description: 'Recibido', source: 'cargotrack' }],
  'demo-2': [
    { packageId: 'demo-2', occurredAt: '2026-06-10T11:09:00Z', office: 'MIA', description: 'Received', source: 'cargotrack' },
    { packageId: 'demo-2', occurredAt: '2026-06-11T09:00:00Z', office: 'MGA', description: 'Entregado en destino', source: 'cargotrack' },
  ],
}

const SEED_PROVIDERS: Provider[] = [
  { id: 'everest', code: 'everest', name: 'Everest Logistics Services', baseUrl: 'https://everest.cargotrack.net', casilleroFilter: '37458', active: true },
  { id: 'global_connection', code: 'global_connection', name: 'Global Connection', baseUrl: '', casilleroFilter: null, active: true },
]

export class MemoryRepository implements TrackingRepository {
  private packages = new Map<string, PackageRecord>()
  private events = new Map<string, EventRecord[]>()

  constructor() {
    for (const p of SEED_PACKAGES) this.packages.set(p.almacenId, { ...p })
    for (const [k, v] of Object.entries(SEED_EVENTS)) this.events.set(k, v.map((e) => ({ ...e })))
  }

  async getPackageByGuia(guia: string): Promise<PackageRecord | null> {
    return this.packages.get(guia) ?? null
  }

  async getPackageByTracking(tracking: string): Promise<PackageRecord | null> {
    for (const p of this.packages.values()) {
      if ((p.trackingNumber ?? '').toUpperCase() === tracking.toUpperCase()) return p
    }
    return null
  }

  async getEvents(packageId: string): Promise<EventRecord[]> {
    return this.events.get(packageId) ?? []
  }

  async getActiveProviders(): Promise<Provider[]> {
    return SEED_PROVIDERS
  }

  async upsertPackage(pkg: Record<string, unknown>): Promise<string | null> {
    const almacenId = String(pkg.almacen_id ?? '')
    if (!almacenId) return null
    const id = this.packages.get(almacenId)?.id ?? `mem-${almacenId}`
    this.packages.set(almacenId, {
      id,
      providerId: String(pkg.provider_id ?? ''),
      almacenId,
      trackingNumber: (pkg.tracking_number as string) ?? null,
      status: (pkg.status as ShipmentStatus) ?? 'desconocido',
    })
    return id
  }

  async upsertPackages(rows: Record<string, unknown>[]): Promise<{ id: string; almacen_id: string }[]> {
    const out: { id: string; almacen_id: string }[] = []
    for (const r of rows) {
      const id = await this.upsertPackage(r)
      if (id) out.push({ id, almacen_id: String(r.almacen_id ?? '') })
    }
    return out
  }

  async upsertEvents(rows: Record<string, unknown>[]): Promise<void> {
    for (const r of rows) {
      const pid = String(r.package_id ?? '')
      if (!pid) continue
      const list = this.events.get(pid) ?? []
      list.push({ packageId: pid, occurredAt: (r.occurred_at as string) ?? null, office: (r.office as string) ?? null, description: String(r.description ?? ''), source: 'cargotrack' })
      this.events.set(pid, list)
    }
  }

  async setManualStatus(packageId: string, status: ShipmentStatus): Promise<void> {
    for (const p of this.packages.values()) {
      if (p.id === packageId) p.manualStatus = status
    }
  }

  async upsertProviderNotes(): Promise<void> {
    /* no-op in demo mode */
  }

  async addTag(): Promise<void> {
    /* no-op in demo mode */
  }

  async addNote(): Promise<void> {
    /* no-op in demo mode */
  }
}
