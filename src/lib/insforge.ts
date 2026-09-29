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
  organization_id: string
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
    // packages.organization_id is NOT NULL FK → agencies.slug (no fallback: a
    // missing value would mis-attribute the package to another tenant).
    organizationId: r.organization_id,
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
  async getPackageByGuia(guia: string, org?: string): Promise<PackageRecord | null> {
    // ADR-013: la identidad de la guía es (organization_id, almacen_id) — la misma guía
    // existe en otros tenants en silencio, así que todo read que conoce el org DEBE
    // filtrarlo (el público/panel pasa org; la legacy admin API queda sin filtro).
    // order=scraped_at.desc se mantiene como defensa (determinismo pre-migración).
    // Soft-deleted packages are out of public track.
    const orgQ = org ? `&organization_id=eq.${encodeURIComponent(org)}` : ''
    const rows = await this.get<DbPackageRow>('packages', `almacen_id=eq.${encodeURIComponent(guia)}&deleted_at=is.null${orgQ}&order=scraped_at.desc&limit=1`)
    return rows[0] ? rowToPackage(rows[0]) : null
  }

  async getPackageByTracking(tracking: string, org?: string): Promise<PackageRecord | null> {
    // Mismo org-scope que getPackageByGuia (ADR-013).
    const orgQ = org ? `&organization_id=eq.${encodeURIComponent(org)}` : ''
    const rows = await this.get<DbPackageRow>('packages', `tracking_number=eq.${encodeURIComponent(tracking)}&deleted_at=is.null${orgQ}&limit=1`)
    return rows[0] ? rowToPackage(rows[0]) : null
  }

  async getEvents(packageId: string): Promise<EventRecord[]> {
    const rows = await this.get<DbEventRow>('events', `package_id=eq.${encodeURIComponent(packageId)}&order=occurred_at.asc`)
    return rows.map(rowToEvent)
  }

  async getOpenAlmacenIds(providerId: string, limit: number): Promise<string[]> {
    const rows = await this.get<{ almacen_id: string; client_id: string | null; billing_clients: { active: boolean } | null }>(
      'packages',
      // Order by scraped_at ASC (least-recently-scraped first), NOT last_event_at: with a capped
      // batch, last_event ordering refreshes the same front subset every tick and STARVES packages
      // with a newer last_event — they never get revisited (observed 2026-07-18: guia 945354 stayed
      // frozen while others refreshed). scraped_at rotates round-robin so every open package is
      // reached within a few ticks.
      `provider_id=eq.${encodeURIComponent(providerId)}&effective_status=neq.entregado&deleted_at=is.null&select=almacen_id,client_id,billing_clients(active)&order=scraped_at.asc&limit=${limit}`,
    )
    // Deactivated clients are out of dashboard range — don't spend refresh budget on them
    // (they come back on reactivation). Packages without a billing client stay refreshable.
    // Soft-deleted packages are terminal: never refreshed again.
    return rows.filter((r) => r.client_id == null || r.billing_clients?.active !== false).map((r) => r.almacen_id)
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

  async getProviderAgencies(): Promise<{ providerId: string; agencySlug: string; casilleroFilter: string | null; isScrapable: boolean }[]> {
    // is_scrapable via to-one embed in the SAME subrequest (routing guard; stays
    // under the 50-subrequest budget: one call per ingest invocation, not per package).
    const rows = await this.get<{
      provider_id: string
      agency_slug: string
      casillero_filter: string | null
      agencies: { is_scrapable: boolean } | null
    }>('provider_agencies', 'select=provider_id,agency_slug,casillero_filter,agencies(is_scrapable)')
    return rows.map((r) => ({
      providerId: r.provider_id,
      agencySlug: r.agency_slug,
      casilleroFilter: r.casillero_filter,
      isScrapable: r.agencies?.is_scrapable ?? true,
    }))
  }

  async isAgencyScrapable(agencySlug: string): Promise<boolean> {
    const rows = await this.get<{ is_scrapable: boolean }>('agencies', `slug=eq.${encodeURIComponent(agencySlug)}&select=is_scrapable&limit=1`)
    return rows[0]?.is_scrapable ?? true
  }

  /** Latest scraped_at per ACTIVE provider (health freshness). One subrequest per provider, limit=1. */
  async getLastScrapeByProvider(): Promise<Record<string, string | null>> {
    const providers = await this.getActiveProviders()
    const out: Record<string, string | null> = {}
    for (const p of providers) {
      const rows = await this.get<{ scraped_at: string }>(
        'packages',
        `provider_id=eq.${encodeURIComponent(p.id)}&deleted_at=is.null&select=scraped_at&order=scraped_at.desc&limit=1`,
      )
      out[p.code] = rows[0]?.scraped_at ?? null
    }
    return out
  }

  /** Upsert a package (conflict on organization_id, almacen_id — guía identity per tenant, ADR-013). Returns its id. */
  async upsertPackage(pkg: Record<string, unknown>): Promise<string | null> {
    const rows = await this.upsertPackages([pkg])
    return rows[0]?.id ?? null
  }

  /**
   * Bulk upsert packages in ONE request, returning the rows (with ids) via
   * `Prefer: return=representation`. Used by the page ingester to stay well under the
   * Worker subrequest limit (1 call for the whole page instead of 2-3 per package).
   *
   * ADR-013: el conflict target es (organization_id, almacen_id) — una guía por tenant.
   * Antes del upsert se corre un pre-check (+1 GET por org): una guía de ESTE tenant ya
   * registrada con OTRO provider son dos paquetes físicos distintos → se omite del batch
   * (nunca se mergea) y se audita en audit_logs. Ver excludeCrossProviderDuplicates.
   */
  async upsertPackages(rows: Record<string, unknown>[]): Promise<{ id: string; almacen_id: string }[]> {
    if (rows.length === 0) return []
    const sendable = await this.excludeCrossProviderDuplicates(rows)
    if (sendable.length === 0) return []
    // PostgREST bulk insert requires every object in the array to share the SAME keys
    // (else PGRST102 "All object keys must match"). Rows are not uniform: only packages with
    // a RETIRADO note carry manual_status*. Group by key signature and send one request per
    // group — this both satisfies PostgREST and keeps rows without an override from ever
    // sending manual_status, so a merge-duplicates upsert never clobbers an admin override.
    const groups = new Map<string, Record<string, unknown>[]>()
    for (const r of sendable) {
      const sig = Object.keys(r).sort().join(',')
      const g = groups.get(sig)
      if (g) g.push(r)
      else groups.set(sig, [r])
    }
    const out: { id: string; almacen_id: string }[] = []
    for (const group of groups.values()) {
      const res = await fetch(`${this.base}/packages?on_conflict=organization_id,almacen_id`, {
        method: 'POST',
        headers: { ...this.headers, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(group),
      })
      if (!res.ok) throw new Error(`Insforge bulk upsert packages → ${res.status}: ${(await res.text()).slice(0, 400)}`)
      out.push(...((await res.json()) as { id: string; almacen_id: string }[]))
    }
    return out
  }

  /**
   * ADR-013 (regla de negocio): dentro de un tenant, una guía propiedad de OTRO provider
   * jamás se mergea — serían dos paquetes físicos distintos. Filtra esas filas del batch
   * y deja un audit_logs (`package.ingest_skipped`) en la tenant dueña para que el admin
   * vea por qué la guía no se actualizó. Filas sin (org, guía) previo o con el MISMO
   * provider pasan sin cambios (merge idempotente). 1 GET por org del batch — el costo de
   * subrequests queda documentado en README.md §`GET /track/:id`.
   */
  private async excludeCrossProviderDuplicates(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const keyed = rows.filter((r) => r.organization_id && r.almacen_id && r.provider_id)
    if (keyed.length === 0 || keyed.length !== rows.length) return rows // sin datos de org/provider → sin pre-check
    const byOrg = new Map<string, Set<string>>()
    for (const r of keyed) {
      const org = String(r.organization_id)
      const ids = byOrg.get(org)
      if (ids) ids.add(String(r.almacen_id))
      else byOrg.set(org, new Set([String(r.almacen_id)]))
    }
    // (org|guía) → provider_id dueño. Incluye filas dadas de baja: siguen ocupando la unique.
    const owner = new Map<string, string>()
    for (const [org, ids] of byOrg) {
      const q = `organization_id=eq.${encodeURIComponent(org)}&almacen_id=in.(${[...ids].map((i) => encodeURIComponent(i)).join(',')})&select=almacen_id,provider_id`
      const res = await fetch(`${this.base}/packages?${q}`, { headers: this.headers })
      if (!res.ok) throw new Error(`Insforge cross-provider pre-check → ${res.status}: ${(await res.text()).slice(0, 300)}`)
      for (const e of (await res.json()) as { almacen_id: string; provider_id: string }[]) {
        owner.set(`${org}|${e.almacen_id}`, e.provider_id)
      }
    }
    const kept: Record<string, unknown>[] = []
    const skipped: { row: Record<string, unknown>; existingProviderId: string }[] = []
    for (const r of rows) {
      const prior = r.organization_id && r.almacen_id ? owner.get(`${r.organization_id}|${r.almacen_id}`) : undefined
      if (prior !== undefined && prior !== String(r.provider_id)) skipped.push({ row: r, existingProviderId: prior })
      else kept.push(r)
    }
    if (skipped.length) await this.auditSkippedDuplicates(skipped)
    return kept
  }

  /** Audit best-effort: un fallo aquí no debe tumbar la ingesta (el skip ya ocurrió; queda el log). */
  private async auditSkippedDuplicates(skipped: { row: Record<string, unknown>; existingProviderId: string }[]): Promise<void> {
    try {
      const payload = skipped.map(({ row, existingProviderId }) => ({
        organization_id: row.organization_id,
        actor_type: 'system',
        action: 'package.ingest_skipped',
        entity_type: 'package',
        entity_id: String(row.almacen_id),
        metadata: {
          almacen_id: row.almacen_id,
          incoming_provider_id: row.provider_id,
          existing_provider_id: existingProviderId,
          reason: 'guía ya registrada en esta tenant con otro proveedor — no se mergea (ADR-013)',
        },
      }))
      const res = await fetch(`${this.base}/audit_logs`, {
        method: 'POST',
        headers: { ...this.headers, Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) console.error(`[insforge] ingest skip audit failed (${res.status}):`, (await res.text()).slice(0, 300))
    } catch (e) {
      console.error('[insforge] ingest skip audit failed:', (e as Error).message)
    }
  }

  /** Replaces a package's events (dedup by unique(package_id, occurred_at, description)). */
  async upsertEvents(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return
    await this.upsert('events', rows, 'package_id,occurred_at,description')
  }

  /** Stores provider Notas (dedup by unique(package_id, body, author, noted_at)). */
  async upsertProviderNotes(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return
    await this.upsert('package_provider_notes', rows, 'package_id,body,author,noted_at')
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
