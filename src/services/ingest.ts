import { parseAlmacenList, parseDetail, isHitPackage, type DetailData, type DetailEvent, type ListRow, type ProviderNote } from '../lib/cargotrack.js'
import { getRepository, type TrackingRepository } from '../lib/repository.js'
import { UpstashRedisClient } from '../lib/session.js'
import type { CloudflareBindings } from '../types/index.js'
import type { Provider, ShipmentStatus } from '../types/tracking.js'

// ============================================================================
// Multi-provider Cargotrack → Insforge ingestion.
// ============================================================================
// Network routes verified live against everest.cargotrack.net (both providers share the
// same Cargotrack engine):
//   - login:  GET /  then  POST /  with  user / password / action=login / Submit="Log In"
//             (the POST regenerates the authenticated ASPSESSIONID cookie)
//   - list:   GET /appl2.0/agent/whs.asp      (Warehouse view; page 1 is the most recent)
//   - detail: GET /appl2.0/agent/whs_detail.asp?id=N
const LIST_PATH = '/appl2.0/agent/whs.asp'
const DETAIL_PATH = '/appl2.0/agent/whs_detail.asp'
const SESSION_TTL_SEC = 2 * 60 // Cargotrack sessions die in ~2-3 min; cache no longer than that
const LOGIN_BACKOFF_SEC = 15 * 60 // after a genuine login failure, wait before trying again
const INGEST_WINDOW_DAYS = 7 // only ingest packages received within this window
const THROTTLE_MS = 900 // base delay between detail fetches (keep the footprint low)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Per-provider credentials (in Cloudflare Secrets, never in the DB).
function credsFor(code: string, env: CloudflareBindings): { user: string; pass: string } | null {
  switch (code) {
    case 'everest':
      return { user: env.EVEREST_USERNAME, pass: env.EVEREST_PASSWORD }
    case 'global_connection':
      return env.GC_USERNAME && env.GC_PASSWORD ? { user: env.GC_USERNAME, pass: env.GC_PASSWORD } : null
    default:
      return null
  }
}

// "6/12/2026" + "14:31" → ISO (or null). Cargotrack uses M/D/YYYY.
function toIso(date?: string, time?: string): string | null {
  if (!date) return null
  const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(date)
  if (!dm) return null
  const [, mo, da, yr] = dm
  const tm = time ? /(\d{1,2}):(\d{2})/.exec(time) : null
  const hh = tm ? tm[1].padStart(2, '0') : '00'
  const mm = tm ? tm[2] : '00'
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}T${hh}:${mm}:00Z`
}

// Keeps rows whose date is within `days` of now. Unknown dates are kept (fail-open).
function withinDays(fecha: string | undefined, days: number): boolean {
  const iso = toIso(fecha)
  if (!iso) return true
  return Date.now() - Date.parse(iso) <= days * 86_400_000
}

export class CargotrackClient {
  private redis: UpstashRedisClient
  private sessionKey: string
  private blockKey: string

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
    env: CloudflareBindings,
    providerCode: string,
  ) {
    this.redis = new UpstashRedisClient(env.UPSTASH_REDIS_URL, env.UPSTASH_REDIS_TOKEN)
    this.sessionKey = `ct:session:${providerCode}`
    this.blockKey = `ct:login_block:${providerCode}`
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async getCookie(): Promise<string> {
    const cached = await this.redis.get<string>(this.sessionKey)
    if (cached) return cached
    return this.login()
  }

  private async login(): Promise<string> {
    // Back off only after a genuine login failure (couldn't reach the agent area), so we
    // never hammer the provider. Cargotrack sessions are short (~2-3 min) — see SESSION_TTL_SEC.
    if (await this.redis.get<number>(this.blockKey)) {
      throw new Error('Login backing off after a recent failure; not retrying yet.')
    }

    // Accumulate cookies across the whole flow (GET → POST → agent landing); the authenticated
    // session cookie is only fully established once we follow to the agent area.
    const jar = new Map<string, string>()
    const merge = (res: Response) => {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const nv = sc.split(';')[0]
        const i = nv.indexOf('=')
        if (i > 0) jar.set(nv.slice(0, i).trim(), nv.slice(i + 1))
      }
    }
    const cookieHeader = () =>
      [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

    // 1. Seed the session.
    merge(await fetch(`${this.baseUrl}/`, { headers: { 'User-Agent': UA }, redirect: 'manual' }))

    // 2. Submit credentials.
    const body = new URLSearchParams({ user: this.username, password: this.password, action: 'login', Submit: 'Log In' })
    const post = await fetch(`${this.baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: `${this.baseUrl}/`, Cookie: cookieHeader() },
      body: body.toString(),
      redirect: 'manual',
    })
    merge(post)

    // 3. Follow the redirect chain, accumulating cookies, until we land in the authenticated area.
    //    The chain goes /validate.asp → /validate_final.asp → a home page; the "accessdenied="
    //    in those URLs is part of the NORMAL flow, not a denial. The landing differs by provider:
    //      - Everest:           /appl2.0/agent/default.asp
    //      - Global Connection: /default.asp (root) — the agent assets load client-side afterwards.
    //    Both then serve the same list (/appl2.0/agent/whs.asp) and detail paths with the cookie.
    let res = post
    let url = `${this.baseUrl}/`
    let sawValidateFinal = false
    for (let hop = 0; hop < 6 && (res.status === 301 || res.status === 302); hop++) {
      const loc = res.headers.get('location')
      if (!loc) break
      url = new URL(loc, this.baseUrl).toString()
      if (/validate_final\.asp/i.test(url)) sawValidateFinal = true
      res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader(), Referer: `${this.baseUrl}/` }, redirect: 'manual' })
      merge(res)
    }

    // Success: Everest lands in the agent area; Global Connection HTTP-terminates on the root
    // /default.asp (its agent UI loads client-side, which we don't execute). A FAILED login also
    // returns to /default.asp but with a credentials error, so when we land there we confirm by
    // page content — an authenticated home carries the "Desconectar" (logout) control, whereas a
    // failure says the user/password is incorrect. Content is the only reliable discriminator here.
    const reachedAgent = /\/appl2\.0\/agent\//i.test(url)
    let reachedHome = false
    if (!reachedAgent && sawValidateFinal && /\/default\.asp(?:[?#]|$)/i.test(url)) {
      const landing = await res.text()
      reachedHome = /desconectar/i.test(landing) && !/password are incorrect/i.test(landing)
    }
    if (!reachedAgent && !reachedHome) {
      await this.redis.set(this.blockKey, 1, LOGIN_BACKOFF_SEC)
      throw new Error(`Login failed (${this.baseUrl}): did not reach the agent area (ended at ${url}).`)
    }

    const cookie = cookieHeader()
    if (!cookie) throw new Error(`Login failed (${this.baseUrl}): no session cookie.`)
    await this.redis.set(this.sessionKey, cookie, SESSION_TTL_SEC)
    return cookie
  }

  private async fetchHtml(path: string, retried = false): Promise<string> {
    const cookie = await this.getCookie()
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Cookie: cookie, 'User-Agent': UA, Referer: `${this.baseUrl}/appl2.0/agent/default.asp` },
      redirect: 'manual',
    })
    // Session expired → Cargotrack 302s back to the login page; re-login once.
    if ((res.status === 301 || res.status === 302) && !retried) {
      await this.redis.del(this.sessionKey)
      return this.fetchHtml(path, true)
    }
    // Cargotrack serves Classic-ASP pages in Windows-1252, not UTF-8; decoding as UTF-8 turns
    // accented characters (ó, í, ñ) into U+FFFD. Decode the raw bytes as Windows-1252.
    return new TextDecoder('windows-1252').decode(await res.arrayBuffer())
  }

  fetchDetail(almacenId: string): Promise<string> {
    return this.fetchHtml(`${DETAIL_PATH}?id=${encodeURIComponent(almacenId)}`)
  }

  fetchListPage(offset = 0): Promise<string> {
    // The Warehouse list paginates by row offset (15 rows/page): offset 0, 15, 30, ...
    const q = offset > 0 ? `?offset=${offset}` : ''
    return this.fetchHtml(`${LIST_PATH}${q}`)
  }
}

// Builds the DB row by combining list + detail.
// organizationId is resolved by the caller from the provider_agencies junction —
// the row never guesses a tenant (no hardcoded fallback).
export function toPackageRow(providerId: string, organizationId: string, baseUrl: string, almacenId: string, list?: ListRow, detail?: DetailData): Record<string, unknown> {
  const status: ShipmentStatus = list?.status ?? detail?.statusFromDetail ?? 'desconocido'
  const lastEvent = detail?.events.at(-1)
  const row: Record<string, unknown> = {
    provider_id: providerId,
    organization_id: organizationId,
    almacen_id: almacenId,
    tracking_number: detail?.trackingNumber ?? null,
    status,
    raw_status: detail?.estadoText ?? list?.rawColor ?? null,
    service_type: detail?.serviceType ?? list?.serviceType ?? null,
    weight_lb: list?.weightLb ?? detail?.weightLb ?? null,
    volume_cf: list?.volumeCf ?? detail?.volumeCf ?? null,
    pieces: list?.pieces ?? detail?.pieces ?? null,
    origin_office: detail?.origin ?? null,
    dest_office: detail?.destination ?? list?.dest ?? null,
    description: detail?.description ?? null,
    // Uploaded photo, when present — not always. Resolved to an absolute URL here since the
    // parser only sees the relative href and doesn't know which provider host it belongs to.
    photo_ref: detail?.photoUrl ? new URL(detail.photoUrl, baseUrl).toString() : null,
    remitente: detail?.shipper ?? list?.remitente ?? null,
    referencia_name: detail?.reference ?? null,
    casillero: detail?.consigneeId ?? null,
    declared_value: detail?.declaredValue ?? list?.declaredValue ?? null,
    received_at: toIso(detail?.events[0]?.date, detail?.events[0]?.time) ?? toIso(list?.fecha) ?? null,
    last_event_at: toIso(lastEvent?.date, lastEvent?.time) ?? null,
    scraped_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Providers that don't flip to "delivered" by color (Global Connection) record it as a
  // "RETIRADO" note. Mirror it into the manual status override. Everest already shows it by
  // color, so `status !== 'entregado'` keeps this effectively GC-only and never clobbers an
  // existing override (when no RETIRADO note, manual_status is omitted and stays untouched).
  const retirado = detail?.notes.find((n) => /retirad/i.test(n.body))
  if (retirado && status !== 'entregado') {
    row.manual_status = 'entregado'
    row.manual_status_by = 'cargotrack-note'
    row.manual_status_at = toIso(retirado.notedAt) ?? new Date().toISOString()
  }
  return row
}

export class IngestService {
  private db: TrackingRepository
  /** provider_id → primary agency slug, loaded once per invocation from the junction. */
  private orgByProvider: Map<string, string> | null = null

  constructor(private env: CloudflareBindings) {
    this.db = getRepository(env)
  }

  /**
   * Resolves the tenant for a provider from the provider_agencies junction (loaded
   * lazily, once per invocation). Returns null when a provider has no agency — the
   * caller must skip it rather than mis-attribute packages to a default tenant.
   */
  private async orgFor(providerId: string): Promise<string | null> {
    if (!this.orgByProvider) {
      const rows = await this.db.getProviderAgencies()
      this.orgByProvider = new Map(rows.map((r) => [r.providerId, r.agencySlug]))
    }
    return this.orgByProvider.get(providerId) ?? null
  }

  private clientFor(p: Provider): CargotrackClient | null {
    const creds = credsFor(p.code, this.env)
    if (!creds) return null
    return new CargotrackClient(p.baseUrl, creds.user, creds.pass, this.env, p.code)
  }

  private async persist(providerId: string, organizationId: string, baseUrl: string, almacenId: string, list: ListRow | undefined, detail: DetailData | undefined): Promise<void> {
    const pkgId = await this.db.upsertPackage(toPackageRow(providerId, organizationId, baseUrl, almacenId, list, detail))
    if (pkgId && detail?.events.length) {
      await this.db.upsertEvents(
        detail.events.map((e) => ({
          package_id: pkgId,
          occurred_at: toIso(e.date, e.time),
          office: e.office ?? null,
          description: e.description,
          status: null,
          source: 'cargotrack',
        })),
      )
    }
    if (pkgId && detail?.notes.length) {
      const seen = new Set<string>()
      const noteRows = detail.notes
        .filter((n) => {
          const key = `${n.body}|${n.author ?? ''}|${n.notedAt ?? ''}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((n) => ({ package_id: pkgId, body: n.body, author: n.author ?? null, noted_at: n.notedAt ?? null }))
      try {
        await this.db.upsertProviderNotes(noteRows)
      } catch (e) {
        console.error('[ingest] provider notes upsert failed (non-fatal):', (e as Error).message)
      }
    }
  }

  /**
   * Fetches details for the given page rows, applies the strict mailbox (casillero) filter,
   * and writes them in BULK (one package upsert + one event upsert) to stay under the Worker
   * subrequest limit. Everest: only the configured mailbox; other providers: keep all.
   */
  private async ingestRows(p: Provider, client: CargotrackClient, rows: ListRow[], windowDays: number): Promise<number> {
    const organizationId = await this.orgFor(p.id)
    if (!organizationId) {
      console.error(`[ingest] ${p.code} has no agency mapping (provider_agencies) — skipping to avoid mis-attributed packages`)
      return 0
    }
    const candidates = (p.casilleroFilter ? rows.filter(isHitPackage) : rows).filter((r) => withinDays(r.fecha, windowDays))

    const pkgRows: Record<string, unknown>[] = []
    const eventsByAlmacen = new Map<string, DetailEvent[]>()
    const notesByAlmacen = new Map<string, ProviderNote[]>()
    for (const row of candidates) {
      if (pkgRows.length > 0) await sleep(THROTTLE_MS + Math.floor(Math.random() * 600))
      let detail: DetailData | undefined
      try {
        detail = parseDetail(await client.fetchDetail(row.almacenId))
      } catch {
        detail = undefined
      }
      // Strict ownership: when the provider filters by mailbox, require the detail's casillero to match.
      if (p.casilleroFilter && detail?.consigneeId && detail.consigneeId !== p.casilleroFilter) continue
      pkgRows.push(toPackageRow(p.id, organizationId, p.baseUrl, row.almacenId, row, detail))
      if (detail?.events.length) eventsByAlmacen.set(row.almacenId, detail.events)
      if (detail?.notes.length) notesByAlmacen.set(row.almacenId, detail.notes)
    }
    if (pkgRows.length === 0) return 0

    // BULK writes: one package upsert (returns ids) + one event upsert — minimal subrequests.
    const upserted = await this.db.upsertPackages(pkgRows)
    const idByAlmacen = new Map(upserted.map((u) => [u.almacen_id, u.id]))
    const eventRows: Record<string, unknown>[] = []
    for (const [almacen, evs] of eventsByAlmacen) {
      const pid = idByAlmacen.get(almacen)
      if (!pid) continue
      for (const e of evs) {
        eventRows.push({ package_id: pid, occurred_at: toIso(e.date, e.time), office: e.office ?? null, description: e.description, status: null, source: 'cargotrack' })
      }
    }
    await this.db.upsertEvents(eventRows)

    const noteRows: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const [almacen, ns] of notesByAlmacen) {
      const pid = idByAlmacen.get(almacen)
      if (!pid) continue
      for (const n of ns) {
        // Dedup within the batch — two identical notes would make ON CONFLICT hit the same row twice (500).
        const key = `${pid}|${n.body}|${n.author ?? ''}|${n.notedAt ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        noteRows.push({ package_id: pid, body: n.body, author: n.author ?? null, noted_at: n.notedAt ?? null })
      }
    }
    // Notes are supplementary — never fail the chunk (packages + events are already saved).
    try {
      await this.db.upsertProviderNotes(noteRows)
    } catch (e) {
      console.error('[ingest] provider notes upsert failed (non-fatal):', (e as Error).message)
    }
    return pkgRows.length
  }

  /**
   * Revisits open (not-yet-delivered) packages directly by id, bypassing the list walk.
   * Fixes a real gap: once a package scrolls past the offsets the routine cron checks, new
   * provider notes (e.g. a RETIRADO added weeks after receipt) never get re-scraped — the list
   * walk only sees whatever page a package currently sits on. Oldest-last-event-first, capped
   * per call to stay well under the Worker subrequest limit.
   */
  async refreshOpenPackages(providerCode: string, limit = 20): Promise<number> {
    const providers = await this.db.getActiveProviders()
    const p = providers.find((x) => x.code === providerCode)
    if (!p) return 0

    const ids = await this.db.getOpenAlmacenIds(p.id, limit)
    let count = 0
    for (const id of ids) {
      if (count > 0) await sleep(THROTTLE_MS + Math.floor(Math.random() * 600))
      try {
        if (await this.ingestOne(providerCode, id, p)) count++
      } catch (e) {
        console.error(`[refresh-open] ${providerCode}/${id} failed:`, (e as Error).message)
      }
    }
    console.log(`[cron] ${providerCode} refresh: updated ${count}/${ids.length} open packages`)
    return count
  }

  /** Ingests ONE package by warehouse number (used by the email trigger). */
  async ingestOne(providerCode: string, almacenId: string, preloadedProvider?: Provider): Promise<boolean> {
    const p = preloadedProvider ?? (await this.db.getActiveProviders()).find((x) => x.code === providerCode)
    if (!p) return false
    const client = this.clientFor(p)
    if (!client) return false

    const organizationId = await this.orgFor(p.id)
    if (!organizationId) {
      console.error(`[ingest] ${p.code} has no agency mapping (provider_agencies) — skipping`)
      return false
    }

    const detail = parseDetail(await client.fetchDetail(almacenId))
    // Ownership filter: if the provider filters by mailbox (casillero), require a match.
    if (p.casilleroFilter && detail.consigneeId !== p.casilleroFilter) return false

    await this.persist(p.id, organizationId, p.baseUrl, almacenId, undefined, detail)
    return true
  }

  /**
   * Walks a provider's Warehouse list and upserts HIT's recent packages.
   * Bounded to the last INGEST_WINDOW_DAYS and throttled between detail fetches to keep
   * the footprint low. The list is date-descending, so paging stops once it leaves the window.
   */
  async ingestProvider(providerCode: string, maxPages = 1, windowDays = INGEST_WINDOW_DAYS): Promise<number> {
    const providers = await this.db.getActiveProviders()
    const p = providers.find((x) => x.code === providerCode)
    if (!p) return 0
    const client = this.clientFor(p)
    if (!client) return 0

    let count = 0
    for (let page = 1; page <= maxPages; page++) {
      const rows = parseAlmacenList(await client.fetchListPage((page - 1) * 15))
      if (rows.length === 0) break

      const mine = p.casilleroFilter ? rows.filter(isHitPackage) : rows
      const recent = mine.filter((r) => withinDays(r.fecha, windowDays))
      count += await this.ingestRows(p, client, rows, windowDays)

      // List is most-recent-first: if this page already fell out of the window, stop paging.
      if (recent.length < mine.length) break
    }
    console.log(`[cron] ${providerCode} list-walk: ingested ${count} packages`)
    return count
  }

  /**
   * Ingests a SINGLE list page at a given row offset (for chunked backfills that fit the
   * Worker time limit). Reuses the cached session across calls, so a multi-offset backfill
   * only logs in once.
   */
  async ingestPage(providerCode: string, offset: number, windowDays = INGEST_WINDOW_DAYS): Promise<number> {
    const providers = await this.db.getActiveProviders()
    const p = providers.find((x) => x.code === providerCode)
    if (!p) return 0
    const client = this.clientFor(p)
    if (!client) return 0

    const rows = parseAlmacenList(await client.fetchListPage(offset))
    return this.ingestRows(p, client, rows, windowDays)
  }

  async ingestAllAtOffset(offset: number, windowDays = INGEST_WINDOW_DAYS): Promise<Record<string, number>> {
    const providers = await this.db.getActiveProviders()
    const out: Record<string, number> = {}
    for (const p of providers) {
      try {
        out[p.code] = await this.ingestPage(p.code, offset, windowDays)
      } catch (e) {
        console.error(`[ingest] ${p.code}@offset${offset} failed:`, (e as Error).message)
        out[p.code] = -1
      }
    }
    return out
  }

  /** Tries to ingest a warehouse number into each active provider (email trigger without a provider). */
  async ingestOneAnyProvider(almacenId: string): Promise<string | null> {
    const providers = await this.db.getActiveProviders()
    for (const p of providers) {
      try {
        if (await this.ingestOne(p.code, almacenId)) return p.code
      } catch (e) {
        console.error(`[ingest] ${p.code}/${almacenId} failed:`, (e as Error).message)
      }
    }
    return null
  }

  async ingestAll(maxPages = 1, windowDays = INGEST_WINDOW_DAYS): Promise<Record<string, number>> {
    const providers = await this.db.getActiveProviders()
    const out: Record<string, number> = {}
    for (const p of providers) {
      try {
        out[p.code] = await this.ingestProvider(p.code, maxPages, windowDays)
      } catch (e) {
        console.error(`[ingest] ${p.code} failed:`, (e as Error).message)
        out[p.code] = -1
      }
    }
    return out
  }
}
