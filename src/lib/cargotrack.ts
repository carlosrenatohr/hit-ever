import type { ServiceType, ShipmentStatus } from '../types/tracking.js'
import { statusFromText } from '../types/tracking.js'

// ============================================================================
// Cargotrack parser (Everest + Global Connection share the same engine).
// Pure (no network): takes HTML, returns data. Tested against real fixtures.
// ============================================================================

// Row color (<tr bgcolor>) in the Warehouse view → status (official legend).
const HEX_TO_STATUS: Record<string, ShipmentStatus> = {
  '#ccffcc': 'en_almacen',  // green
  '#ffffcc': 'parcial',     // yellow
  '#ffcccc': 'en_transito', // red/pink
  '#ccccff': 'en_destino',  // purple
  '#ffe8b0': 'entregado',   // orange
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── List (Warehouse view) ────────────────────────────────────────────────────
export interface ListRow {
  almacenId: string
  dest?: string
  fecha?: string
  remitente?: string
  destinatario?: string
  pieces?: number
  weightLb?: number
  volumeCf?: number
  declaredValue?: number
  serviceType?: ServiceType
  status: ShipmentStatus
  rawColor?: string
}

function num(s?: string): number | undefined {
  if (!s) return undefined
  const n = parseFloat(s)
  return Number.isNaN(n) ? undefined : n
}

/**
 * Parses the Warehouse view table. Each package is a <tr bgcolor="#..">
 * with 10 cells wrapped in <a href="whs_detail.asp?id=NNN">.
 * Cell order: [icon], dest, warehouse, date, sender, recipient,
 * pieces, weight(gross/chargeable), volume, value.
 */
export function parseAlmacenList(html: string): ListRow[] {
  const rows: ListRow[] = []
  const rowRe = /<tr\s+bgcolor="(#[0-9A-Fa-f]{6})"[\s\S]*?<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html)) !== null) {
    const chunk = m[0]
    if (!/whs_detail\.asp\?id=/.test(chunk)) continue

    const color = m[1].toLowerCase()
    const idMatch = /whs_detail\.asp\?id=(\d+)/.exec(chunk)
    if (!idMatch) continue

    const linkRe = /<a\s+href="whs_detail\.asp\?id=\d+"[^>]*>([\s\S]*?)<\/a>/gi
    const t: string[] = []
    let lm: RegExpExecArray | null
    while ((lm = linkRe.exec(chunk)) !== null) t.push(stripTags(lm[1]))

    const serviceType: ServiceType | undefined = /airplane/i.test(chunk)
      ? 'aereo'
      : /anchor/i.test(chunk)
        ? 'maritimo'
        : undefined

    rows.push({
      almacenId: idMatch[1],
      dest: t[1] || undefined,
      fecha: t[3] || undefined,
      remitente: t[4] || undefined,
      destinatario: t[5] || undefined,
      pieces: num(t[6]),
      weightLb: num((t[7] || '').split('/')[0]), // "2.8/5" → gross weight
      volumeCf: num(t[8]),
      declaredValue: num(t[9]),
      serviceType,
      status: HEX_TO_STATUS[color] ?? 'desconocido',
      rawColor: color,
    })
  }
  return rows
}

/** Is the package HIT's? (shared account: filter by recipient). */
export function isHitPackage(row: ListRow): boolean {
  return /hit\s*cargo/i.test(row.destinatario ?? '')
}

// ─── Detail (whs_detail.asp) ──────────────────────────────────────────────────
export interface DetailEvent {
  date?: string
  time?: string
  office?: string
  description: string
}

export interface ProviderNote {
  body: string
  author?: string
  notedAt?: string // raw source date, e.g. "5/28/2026 11:32:00 AM"
}

export interface DetailData {
  almacenId?: string
  date?: string
  office?: string
  shipper?: string // sender (remitente)
  consigneeId?: string // mailbox (casillero)
  consignee?: string
  reference?: string // customer name
  origin?: string
  destination?: string
  trackingNumber?: string
  description?: string
  declaredValue?: number
  held?: boolean
  serviceType?: ServiceType
  estadoText?: string // package status, e.g. "In Transit"
  statusFromDetail: ShipmentStatus
  events: DetailEvent[]
  notes: ProviderNote[]
  photoUrl?: string // relative to the provider's host, e.g. "/items/DP_....jpg" — resolve before storing
}

function inputVal(html: string, name: string): string | undefined {
  const re = new RegExp(`name="${name}"[^>]*?\\bvalue="([\\s\\S]*?)"`, 'i')
  const m = re.exec(html)
  if (!m) return undefined
  const v = m[1].replace(/\s+/g, ' ').trim()
  return v || undefined
}

function sliceBetween(html: string, startMarker: RegExp, endMarker: RegExp): string {
  const s = startMarker.exec(html)
  if (!s) return ''
  const rest = html.slice(s.index + s[0].length)
  const e = endMarker.exec(rest)
  return e ? rest.slice(0, e.index) : rest
}

function mapService(raw?: string): ServiceType | undefined {
  if (!raw) return undefined
  const v = raw.trim()
  // Everest's hidden field spells the word out ("AÉREO"/"MARÍTIMO"). Global Connection's only
  // carries the <select name="shipping_instructions"> OPTION CODE (A/O/T) — confirmed on guia
  // 158374's real HTML, whose "Instrucciones" dropdown showed MARÍTIMO selected but the hidden
  // field was just "O". A bare code letter never matched the word regexes below, so it silently
  // fell through to service_type = null for every GC package this happened on.
  if (/^a$/i.test(v) || /a[eé]reo|air/i.test(v)) return 'aereo'
  if (/^o$/i.test(v) || /mar[ií]timo|ocean|sea/i.test(v)) return 'maritimo'
  // 'T' = terrestre, a real Cargotrack option — just not one of the two HIT tracks.
  return undefined
}

export function parseDetail(html: string): DetailData {
  const trackingRaw = inputVal(html, 'tracking_number')
  const tracking = trackingRaw ? trackingRaw.replace(/\s+/g, '') : undefined

  // Tracking events ("Eventos de Seguimiento"): table of <tr valign="top"> rows with 4 cells.
  const eventsBlock = sliceBetween(html, /Eventos de Seguimiento/i, /Notas/i)
  const events: DetailEvent[] = []
  const evRe =
    /<tr[^>]*valign="top"[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi
  let ev: RegExpExecArray | null
  while ((ev = evRe.exec(eventsBlock)) !== null) {
    const description = stripTags(ev[4])
    if (!description) continue
    events.push({
      date: stripTags(ev[1]) || undefined,
      time: stripTags(ev[2]) || undefined,
      office: stripTags(ev[3]) || undefined,
      description,
    })
  }

  // Notes: "Notas" table → each <td class="ntextrow"> is a note (except the header).
  const notesBlock = sliceBetween(html, /<td[^>]*>Notas<\/td>/i, /Archivo/i)
  const notes: ProviderNote[] = []
  const noteRe = /<td[^>]*class="ntextrow"[^>]*>([\s\S]*?)<\/td>/gi
  let nt: RegExpExecArray | null
  while ((nt = noteRe.exec(notesBlock)) !== null) {
    const text = stripTags(nt[1])
    if (!text) continue
    // "<body> Creado por <author> el <date>"
    const m = /^(.*?)\s*creado por\s+(.+?)\s+el\s+(.+)$/i.exec(text)
    notes.push(m ? { body: m[1].trim(), author: m[2].trim(), notedAt: m[3].trim() } : { body: text })
  }

  // Uploaded photo (not always present): "Archivo" table → first <a href> is the file link.
  // The href is a plain relative path on the provider's own host, no auth query params —
  // confirmed publicly reachable (e.g. https://gc.cargotrack.net/items/DP_....jpg).
  const archivoBlock = sliceBetween(html, /<td[^>]*>Archivo<\/td>/i, /<\/table>/i)
  const photoMatch = /<a[^>]+href="([^"]+)"/i.exec(archivoBlock)
  const photoUrl = photoMatch ? photoMatch[1] : undefined

  // Package status (e.g. "In Transit") in the measurements table.
  const estadoText = (html.match(/\b(In Transit|Received|Delivered|At Destination|Partial|On Hold|Hold)\b/i) ?? [])[0]

  // shipping_instructions2 mirrors the real "Instrucciones" <select> (its value is the option
  // code A/O/T) on BOTH providers — confirmed live on Everest and GC. shipping_type2 is not a
  // reliable alternate source: it was "" for GC and the literal string "NONE" for Everest in
  // every sample checked, and being a non-empty string it used to win the old `??` precedence,
  // silently discarding the good field. Try the real field first; shipping_type2 is now only a
  // last-resort fallback in case some page variant actually populates it with a real word.
  const service = mapService(inputVal(html, 'shipping_instructions2')) ?? mapService(inputVal(html, 'shipping_type2'))

  return {
    almacenId: inputVal(html, 'id'),
    date: inputVal(html, 'date'),
    office: inputVal(html, 'branch'),
    shipper: inputVal(html, 'shipper'),
    consigneeId: inputVal(html, 'consignee_id'),
    consignee: inputVal(html, 'consignee'),
    reference: inputVal(html, 'reference'),
    origin: inputVal(html, 'origin'),
    destination: inputVal(html, 'destination'),
    trackingNumber: tracking,
    description: inputVal(html, 'description'),
    declaredValue: num(inputVal(html, 'inv_value')),
    held: (inputVal(html, 'hold2') ?? 'N').toUpperCase() === 'Y',
    serviceType: service,
    estadoText: estadoText || undefined,
    statusFromDetail: estadoText ? statusFromText(estadoText) : 'desconocido',
    events,
    notes,
    photoUrl,
  }
}

// ─── Update email ("Recibo de almacén NNN") ───────────────────────────────────
/** Extracts the warehouse number (almacén #) from a Cargotrack email (subject or cid= in links). */
export function almacenIdFromEmail(raw: string): string | null {
  return (
    /almac[eé]n\s+(\d{4,})/i.exec(raw)?.[1] ??
    /[?&]cid=(\d{4,})/i.exec(raw)?.[1] ??
    null
  )
}
