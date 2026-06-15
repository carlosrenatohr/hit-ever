// ============================================================================
// Tracker domain model (Cargotrack: Everest + Global Connection)
// ============================================================================
// Kept separate from types/index.ts to avoid breaking the legacy scraper during migration (B2).
// Statuses follow the official Cargotrack LEGEND (printed on the Warehouse view).

export type ShipmentStatus =
  | 'en_almacen'   // 🟢 green:   In warehouse (Miami warehouse)
  | 'parcial'      // 🟡 yellow:  Partial
  | 'en_transito'  // 🔴 red:     Shipped / In transit
  | 'en_destino'   // 🟣 purple:  At destination (Nicaragua)
  | 'entregado'    // 🟠 orange:  Delivered at destination
  | 'excepcion'    // held / blocked
  | 'desconocido'

export type ServiceType = 'aereo' | 'maritimo'

// ─── Database records (internal) ──────────────────────────────────────────────
export interface Provider {
  id: string
  code: string            // 'everest' | 'global_connection'
  name: string
  baseUrl: string
  casilleroFilter: string | null  // '37458' in Everest; null = accept everything (Global Connection)
  active: boolean
}

export interface PackageRecord {
  id?: string
  providerId: string
  almacenId: string                 // waybill number (guía) 926791 / 160914 — primary public key
  trackingNumber?: string | null    // carrier, normalized
  status: ShipmentStatus            // scraped status
  rawStatus?: string | null
  serviceType?: ServiceType | null
  weightLb?: number | null
  volumeCf?: number | null
  pieces?: number | null
  dimensions?: string | null
  originOffice?: string | null      // MIA
  destOffice?: string | null        // MGA
  description?: string | null
  remitente?: string | null
  // internal — NEVER expose in the public payload:
  referenciaName?: string | null    // customer name (PII)
  casillero?: string | null
  declaredValue?: number | null
  photoRef?: string | null
  receivedAt?: string | null
  lastEventAt?: string | null
  // manual override (e.g. Global Connection does not mark "entregado"; HIT sets it by hand):
  manualStatus?: ShipmentStatus | null
  manualStatusAt?: string | null
  manualStatusBy?: string | null
  manualStatusNote?: string | null
  scrapedAt?: string
}

export interface EventRecord {
  id?: string
  packageId?: string
  occurredAt?: string | null
  office?: string | null
  description: string
  status?: ShipmentStatus | null
  source?: 'cargotrack' | 'carrier_api'
}

// ─── PUBLIC payload (what the customer sees) ──────────────────────────────────
// MINIMAL subset: no mailbox (casillero), reference (PII), value, photo, or others' data.
export interface PublicEvent {
  date: string
  description: string
  office?: string
}

export interface PublicShipment {
  guia: string                 // almacenId
  status: ShipmentStatus
  statusLabel: string
  step: number                 // 1..4 for the progress bar (0 = exception/unknown)
  serviceType?: ServiceType
  weightLb?: number
  pieces?: number
  receivedAt?: string
  lastEventAt?: string
  events: PublicEvent[]
}

// ─── Status mappings ──────────────────────────────────────────────────────────
// Cargotrack row color → status (official legend).
export const COLOR_TO_STATUS: Record<string, ShipmentStatus> = {
  green: 'en_almacen',
  yellow: 'parcial',
  red: 'en_transito',
  pink: 'en_transito',
  purple: 'en_destino',
  orange: 'entregado',
}

// Text of the "Estado" field / events (Cargotrack mixes English and Spanish) → status.
const TEXT_STATUS_PATTERNS: [RegExp, ShipmentStatus][] = [
  [/entregad|delivered|retirad/i, 'entregado'],
  [/destino|destination|arriv|lleg/i, 'en_destino'],
  [/transit|tr[áa]nsito|enviad|shipped|loaded/i, 'en_transito'],
  [/parcial|partial/i, 'parcial'],
  [/recib|received|almac[eé]n|warehouse/i, 'en_almacen'],
  [/reten|hold|bloque|block/i, 'excepcion'],
]

export function statusFromText(text: string): ShipmentStatus {
  for (const [re, status] of TEXT_STATUS_PATTERNS) {
    if (re.test(text)) return status
  }
  return 'desconocido'
}

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  en_almacen: 'En bodega Miami',
  parcial: 'En preparación',
  en_transito: 'En camino',
  en_destino: 'En Nicaragua',
  entregado: 'Entregado',
  excepcion: 'Retenido',
  desconocido: 'Sin información',
}

// Step in the 4-stage bar: Miami → In transit → Nicaragua → Delivered.
export const STATUS_STEP: Record<ShipmentStatus, number> = {
  en_almacen: 1,
  parcial: 2,
  en_transito: 2,
  en_destino: 3,
  entregado: 4,
  excepcion: 0,
  desconocido: 0,
}

// EFFECTIVE status: the manual override wins over the scraped one.
export function effectiveStatus(pkg: PackageRecord): ShipmentStatus {
  return pkg.manualStatus ?? pkg.status
}

// Normalizes the carrier tracking number to index/search consistently.
export function normalizeTracking(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

// Builds the minimal public payload from an internal record.
export function toPublicShipment(pkg: PackageRecord, events: EventRecord[]): PublicShipment {
  const status = effectiveStatus(pkg)
  return {
    guia: pkg.almacenId,
    status,
    statusLabel: STATUS_LABEL[status],
    step: STATUS_STEP[status],
    serviceType: pkg.serviceType ?? undefined,
    weightLb: pkg.weightLb ?? undefined,
    pieces: pkg.pieces ?? undefined,
    receivedAt: pkg.receivedAt ?? undefined,
    lastEventAt: pkg.lastEventAt ?? undefined,
    events: events
      .filter((e) => e.occurredAt)
      .map((e) => ({
        date: e.occurredAt as string,
        description: e.description,
        office: e.office ?? undefined,
      })),
  }
}
