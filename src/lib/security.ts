// Small security helpers shared by the admin/hook auth paths.

/**
 * Constant-time string comparison. A plain `a !== b` short-circuits on the first
 * differing byte, leaking length/prefix timing. We hash both sides with SHA-256
 * (fixed-length digests) and XOR-compare, so the work is independent of the input.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const x = new Uint8Array(da)
  const y = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/**
 * Parse an integer query param with a validated fallback. Non-numeric input
 * (`Number('abc') → NaN`) would otherwise survive `Math.min/max` as NaN and
 * silently corrupt the request (e.g. `&limit=NaN` injected into PostgREST).
 */
export function intParam(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
