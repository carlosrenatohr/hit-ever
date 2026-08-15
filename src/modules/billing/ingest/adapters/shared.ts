// Shared cell coercion helpers + column maps for the sheet adapters.

/** Numeric cell -> number, else null. Handles float/int and numeric strings. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return null
}

/** Text cell -> trimmed string, else null. */
export function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Coerce numero_factura (float or int) to an int, else null. */
export function toInvoiceNumber(v: unknown): number | null {
  const n = num(v)
  return n == null ? null : Math.trunc(n)
}

/** Date cell (JS Date | ISO/US string) -> ISO yyyy-mm-dd, else null. */
export function toIsoDate(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  if (s === '') return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** A cell A that begins with "TOTAL " marks a manual subtotal row (drop it). */
export function isSubtotalRow(cellA: unknown): boolean {
  return typeof cellA === 'string' && cellA.trim().toUpperCase().startsWith('TOTAL ')
}

/** Truthy-ish flag for the "Precio especial" column. */
export function toBool(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no'
}

// Column indexes (0-based) per sheet family.
export const COLS_2025 = {
  num: 0, client: 1, date: 2, oc: 3, address: 4, tipo: 5, desc: 6,
  lbs: 7, unit: 8, unitPrice: 9, total: 10, listPrice: 11, pago: 12,
  payDate: 13, cost: 14, profit: 15, obs: 16, special: 17,
} as const

export const COLS_2026 = {
  num: 0, client: 1, date: 2, oc: 3, tipo: 4, lbs: 5, unit: 6, unitPrice: 7,
  total: 8, listPrice: 9, pago: 10, payDate: 11, cost: 12, profit: 13,
  obs: 14, special: 15,
} as const
