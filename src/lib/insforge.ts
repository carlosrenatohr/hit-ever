import type { EventRecord, PackageRecord, Provider, ServiceType, ShipmentStatus } from '../types/tracking.js'
import type { TrackingRepository } from './repository.js'

// ============================================================================
// Insforge client (Postgres + PostgREST-style REST) — via fetch, Workers-friendly.
// ============================================================================
// Endpoints: GET/POST/PATCH /api/records/{table}. INSERT: the body MUST be an array.
// Auth: backend API key in `Authorization: Bearer`. The API key lives ONLY in the Worker
// (Cloudflare Secret), never in the client. PostgREST-style filters: ?col=eq.value
//
// NOTE: confirm the API host and the exact API key format in the Insforge dashboard
// (Settings → API). INSFORGE_API_URL = base without trailing slash (e.g. https://<proj>.insforge.dev).

interface DbPackageRow {
  id: string
  provider_id: string
  almacen_id: string
  tracking_number: string | null
  status: ShipmentStatus
  raw_status: string | null
  service_type: ServiceType | null
  weight_lb: number | null
  volume_cf: number | null
  pieces: number | null
  dimensions: string | null
  origin_office: string | null
  dest_office: string | null
  description: string | null
  remitente: string | null
  referencia_name: string | null
  casillero: string | null
  declared_value: number | null
  photo_ref: string | null
  received_at: string | null
  last_event_at: string | null
  manual_status: ShipmentStatus | null
  manual_status_at: string | null
  manual_status_by: string | null
  manual_status_note: string | null
  scraped_at: string
}

interface DbEventRow {
  id: string
  package_id: string
  occurred_at: string | null
  office: string | null
  description: string
  status: ShipmentStatus | null
  source: 'cargotrack' | 'carrier_api'
}

export interface DbProviderRow {
  id: string
  code: string
  name: string
  base_url: string
  casillero_filter: string | null
  active: boolean
}

function rowToPackage(r: DbPackageRow): PackageRecord {
  return {
    id: r.id,
    providerId: r.provider_id,
    almacenId: r.almacen_id,
    trackingNumber: r.tracking_number,
    status: r.status,
    rawStatus: r.raw_status,
    serviceType: r.service_type,
    weightLb: r.weight_lb,
    volumeCf: r.volume_cf,
    pieces: r.pieces,
    dimensions: r.dimensions,
    originOffice: r.origin_office,
    destOffice: r.dest_office,
    description: r.description,
    remitente: r.remitente,
    referenciaName: r.referencia_name,
    casillero: r.casillero,
    declaredValue: r.declared_value,
    photoRef: r.photo_ref,
    receivedAt: r.received_at,
    lastEventAt: r.last_event_at,
    manualStatus: r.manual_status,
    manualStatusAt: r.manual_status_at,
    manualStatusBy: r.manual_status_by,
    manualStatusNote: r.manual_status_note,
    scrapedAt: r.scraped_at,
  }
}

function rowToEvent(r: DbEventRow): EventRecord {
  return {
    id: r.id,
    packageId: r.package_id,
    occurredAt: r.occurred_at,
    office: r.office,
    description: r.description,
    status: r.status,
    source: r.source,
  }
}

export class InsforgeClient implements TrackingRepository {
  private base: string
  private headers: Record<string, string>

  constructor(apiUrl: string, apiKey: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/api/database/records`
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private async get<T>(table: string, query: string): Promise<T[]> {
    const res = await fetch(`${this.base}/${table}?${query}`, { headers: this.headers })
    if (!res.ok) throw new Error(`Insforge GET ${table} → ${res.status}`)
    return (await res.json()) as T[]
  }

  /** Insert/upsert: the body MUST be an array. Upsert by conflict columns. */
  private async upsert(table: string, rows: Record<string, unknown>[], onConflict?: string): Promise<void> {
    const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : ''
    const res = await fetch(`${this.base}/${table}${q}`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    })
    if (!res.ok) throw new Error(`Insforge POST ${table} → ${res.status}`)
  }

  private async patch(table: string, query: string, patch: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...this.headers, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`Insforge PATCH ${table} → ${res.status}`)
  }

  // ─── Public read ───────────────────────────────────────────────────────────────
  async getPackageByGuia(guia: string): Promise<PackageRecord | null> {
    const rows = await this.get<DbPackageRow>('packages', `almacen_id=eq.${encodeURIComponent(guia)}&limit=1`)
    return rows[0] ? rowToPackage(rows[0]) : null
  }

  async getPackageByTracking(tracking: string): Promise<PackageRecord | null> {
    const rows = await this.get<DbPackageRow>('packages', `tracking_number=eq.${encodeURIComponent(tracking)}&limit=1`)
    return rows[0] ? rowToPackage(rows[0]) : null
  }

  async getEvents(packageId: string): Promise<EventRecord[]> {
    const rows = await this.get<DbEventRow>('events', `package_id=eq.${encodeURIComponent(packageId)}&order=occurred_at.asc`)
    return rows.map(rowToEvent)
  }

  // ─── Ingestion (B3) ──────────────────────────────────────────────────────────
  async getActiveProviders(): Promise<Provider[]> {
    const rows = await this.get<DbProviderRow>('providers', 'active=eq.true')
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      baseUrl: r.base_url,
      casilleroFilter: r.casillero_filter,
      active: r.active,
    }))
  }

  /** Upsert a package (conflict on provider_id, almacen_id). Returns its id. */
  async upsertPackage(pkg: Record<string, unknown>): Promise<string | null> {
    await this.upsert('packages', [pkg], 'provider_id,almacen_id')
    const rows = await this.get<{ id: string }>(
      'packages',
      `provider_id=eq.${pkg.provider_id}&almacen_id=eq.${pkg.almacen_id}&limit=1`,
    )
    return rows[0]?.id ?? null
  }

  /** Replaces a package's events (dedup by unique(package_id, occurred_at, description)). */
  async upsertEvents(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return
    await this.upsert('events', rows, 'package_id,occurred_at,description')
  }

  // ─── Internal tool (B6) ────────────────────────────────────────────────────────
  async setManualStatus(packageId: string, status: ShipmentStatus, by: string, note?: string, at?: string): Promise<void> {
    await this.patch('packages', `id=eq.${encodeURIComponent(packageId)}`, {
      manual_status: status,
      manual_status_by: by,
      manual_status_note: note ?? null,
      manual_status_at: at ?? null,
    })
  }

  async addTag(packageId: string, label: string, value: string | null, by: string): Promise<void> {
    await this.upsert('package_tags', [{ package_id: packageId, label, value, created_by: by }])
  }

  async addNote(packageId: string, body: string, by: string): Promise<void> {
    await this.upsert('package_notes', [{ package_id: packageId, body, created_by: by }])
  }
}
