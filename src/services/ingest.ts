import { parseAlmacenList, parseDetail, isHitPackage, type DetailData, type ListRow } from '../lib/cargotrack.js'
import { getRepository, type TrackingRepository } from '../lib/repository.js'
import { UpstashRedisClient } from '../lib/session.js'
import type { CloudflareBindings } from '../types/index.js'
import type { Provider, ShipmentStatus } from '../types/tracking.js'

// ============================================================================
// Multi-provider Cargotrack → Insforge ingestion.
// ============================================================================
// The PARSER (lib/cargotrack.ts) is validated against real fixtures.
// The NETWORK ROUTES must be verified live (there was no login fixture):
//   - login:  POST {base}/default.asp  with fields txtUser/txtPassword/btnLogin
//   - detail: GET {base}{DETAIL_PATH}?id=N   (whs_detail confirmed in the list links)
//   - list:   GET {base}{LIST_PATH}?...      (URL/pagination TO BE CONFIRMED)
// Adjust these constants after the first run.

const LOGIN_PATH = '/default.asp'
const DETAIL_PATH = '/appl2.0/cgi/whs_detail.asp'
const LIST_PATH = '/appl2.0/cgi/whs_list.asp' // ⚠ TO BE CONFIRMED (real URL of the Warehouse view)
const SESSION_TTL_SEC = 13 * 60
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

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

export class CargotrackClient {
  private redis: UpstashRedisClient
  private sessionKey: string

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
    env: CloudflareBindings,
    providerCode: string,
  ) {
    this.redis = new UpstashRedisClient(env.UPSTASH_REDIS_URL, env.UPSTASH_REDIS_TOKEN)
    this.sessionKey = `ct:session:${providerCode}`
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async getCookie(): Promise<string> {
    const cached = await this.redis.get<string>(this.sessionKey)
    if (cached) return cached
    return this.login()
  }

  private async login(): Promise<string> {
    const body = new URLSearchParams({
      txtUser: this.username,
      txtPassword: this.password,
      btnLogin: 'Entrar',
    })
    const res = await fetch(`${this.baseUrl}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: body.toString(),
      redirect: 'manual',
    })
    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    if (!cookie) throw new Error(`Login failed (${this.baseUrl}): no cookies. Status ${res.status}. Check the form fields.`)
    await this.redis.set(this.sessionKey, cookie, SESSION_TTL_SEC)
    return cookie
  }

  private async fetchHtml(path: string, retried = false): Promise<string> {
    const cookie = await this.getCookie()
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Cookie: cookie, 'User-Agent': UA, Referer: `${this.baseUrl}/` },
      redirect: 'manual',
    })
    if ((res.status === 301 || res.status === 302) && !retried) {
      await this.redis.del(this.sessionKey)
      return this.fetchHtml(path, true)
    }
    return res.text()
  }

  fetchDetail(almacenId: string): Promise<string> {
    return this.fetchHtml(`${DETAIL_PATH}?id=${encodeURIComponent(almacenId)}`)
  }

  fetchListPage(page = 1): Promise<string> {
    return this.fetchHtml(`${LIST_PATH}?page=${page}`)
  }
}

// Builds the DB row by combining list + detail.
function toPackageRow(providerId: string, almacenId: string, list?: ListRow, detail?: DetailData): Record<string, unknown> {
  const status: ShipmentStatus = list?.status ?? detail?.statusFromDetail ?? 'desconocido'
  const lastEvent = detail?.events.at(-1)
  return {
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

    const pkgId = await this.db.upsertPackage(toPackageRow(p.id, almacenId, undefined, detail))
    if (pkgId && detail.events.length) {
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
    return true
  }

  /** Walks a provider's (capped) list and upserts HIT's packages. */
  async ingestProvider(providerCode: string, maxPages = 1, enrichDetail = true): Promise<number> {
    const providers = await this.db.getActiveProviders()
    const p = providers.find((x) => x.code === providerCode)
    if (!p) return 0
    const client = this.clientFor(p)
    if (!client) return 0

    let count = 0
    for (let page = 1; page <= maxPages; page++) {
      const rows = parseAlmacenList(await client.fetchListPage(page))
      if (rows.length === 0) break

      // Filter: in shared accounts (casillero_filter not null) only HIT's packages.
      const mine = p.casilleroFilter ? rows.filter(isHitPackage) : rows

      for (const row of mine) {
        let detail: DetailData | undefined
        if (enrichDetail) {
          try {
            detail = parseDetail(await client.fetchDetail(row.almacenId))
          } catch {
            detail = undefined
          }
        }
        const pkgId = await this.db.upsertPackage(toPackageRow(p.id, row.almacenId, row, detail))
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
        count++
      }
    }
    return count
  }

  /** Tries to ingest a warehouse number into each active provider (for the email trigger without a provider). */
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

  async ingestAll(maxPages = 1): Promise<Record<string, number>> {
    const providers = await this.db.getActiveProviders()
    const out: Record<string, number> = {}
    for (const p of providers) {
      try {
        out[p.code] = await this.ingestProvider(p.code, maxPages)
      } catch (e) {
        console.error(`[ingest] ${p.code} failed:`, (e as Error).message)
        out[p.code] = -1
      }
    }
    return out
  }
}
