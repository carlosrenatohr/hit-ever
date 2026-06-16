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

    // 3. Follow the redirect chain, accumulating cookies, until we land in the agent area.
    //    A successful login goes /validate.asp → /validate_final.asp → /appl2.0/agent/default.asp;
    //    the "accessdenied=" in those URLs is part of the NORMAL flow, not a denial.
    let res = post
    let url = `${this.baseUrl}/`
    for (let hop = 0; hop < 6 && (res.status === 301 || res.status === 302); hop++) {
      const loc = res.headers.get('location')
      if (!loc) break
      url = new URL(loc, this.baseUrl).toString()
      res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader(), Referer: `${this.baseUrl}/` }, redirect: 'manual' })
      merge(res)
    }

    if (!/\/appl2\.0\/agent\//i.test(url)) {
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
    return res.text()
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
function toPackageRow(providerId: string, almacenId: string, list?: ListRow, detail?: DetailData): Record<string, unknown> {
  const status: ShipmentStatus = list?.status ?? detail?.statusFromDetail ?? 'desconocido'
  const lastEvent = detail?.events.at(-1)
  const row: Record<string, unknown> = {
    provider_id: providerId,
    almacen_id: almacenId,
    tracking_number: detail?.trackingNumber ?? null,
    status,
    raw_status: detail?.estadoText ?? list?.rawColor ?? null,
    service_type: detail?.serviceType ?? list?.serviceType ?? null,
    weight_lb: list?.weightLb ?? null,
    volume_cf: list?.volumeCf ?? null,
    pieces: list?.pieces ?? null,
    origin_office: detail?.origin ?? null,
    dest_office: detail?.destination ?? list?.dest ?? null,
    description: detail?.description ?? null,
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

  constructor(private env: CloudflareBindings) {
    this.db = getRepository(env)
  }

  private clientFor(p: Provider): CargotrackClient | null {
    const creds = credsFor(p.code, this.env)
    if (!creds) return null
    return new CargotrackClient(p.baseUrl, creds.user, creds.pass, this.env, p.code)
  }

  private async persist(providerId: string, almacenId: string, list: ListRow | undefined, detail: DetailData | undefined): Promise<void> {
    const pkgId = await this.db.upsertPackage(toPackageRow(providerId, almacenId, list, detail))
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
      await this.db.upsertProviderNotes(
        detail.notes.map((n) => ({ package_id: pkgId, body: n.body, author: n.author ?? null, noted_at: n.notedAt ?? null })),
      )
    }
  }

  /**
   * Fetches details for the given page rows, applies the strict mailbox (casillero) filter,
   * and writes them in BULK (one package upsert + one event upsert) to stay under the Worker
   * subrequest limit. Everest: only the configured mailbox; other providers: keep all.
   */
  private async ingestRows(p: Provider, client: CargotrackClient, rows: ListRow[], windowDays: number): Promise<number> {
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
      pkgRows.push(toPackageRow(p.id, row.almacenId, row, detail))
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
    for (const [almacen, ns] of notesByAlmacen) {
      const pid = idByAlmacen.get(almacen)
      if (!pid) continue
      for (const n of ns) {
        noteRows.push({ package_id: pid, body: n.body, author: n.author ?? null, noted_at: n.notedAt ?? null })
      }
    }
    await this.db.upsertProviderNotes(noteRows)
    return pkgRows.length
  }

  /** Ingests ONE package by warehouse number (used by the email trigger). */
  async ingestOne(providerCode: string, almacenId: string): Promise<boolean> {
    const providers = await this.db.getActiveProviders()
    const p = providers.find((x) => x.code === providerCode)
    if (!p) return false
    const client = this.clientFor(p)
    if (!client) return false

    const detail = parseDetail(await client.fetchDetail(almacenId))
    // Ownership filter: if the provider filters by mailbox (casillero), require a match.
    if (p.casilleroFilter && detail.consigneeId !== p.casilleroFilter) return false

    await this.persist(p.id, almacenId, undefined, detail)
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
