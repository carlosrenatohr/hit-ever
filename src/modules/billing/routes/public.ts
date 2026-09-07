// ============================================================================
// Public receipt — no auth. Mounted at /billing/r/:token (NOT under the gated
// billing router). Returns a self-contained, printable HTML receipt with only
// customer-safe fields. The token is an unguessable per-invoice UUID.
// ============================================================================

import { Hono } from 'hono'
import type { FreightType } from '../domain/enums.js'
import { getBillingRepo } from '../repo/billing-repo.js'
import { BillingService, type PublicReceipt } from '../service/billing-service.js'
import type { CloudflareBindings } from '../../../types/index.js'

const publicReceipt = new Hono<{ Bindings: CloudflareBindings }>()

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}
const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`
const FREIGHT_ES: Record<FreightType, string> = { AIR: 'Aéreo', MAR: 'Marítimo' }
const STATUS_ES: Record<string, string> = { DRAFT: 'Borrador', ISSUED: 'Emitida', PARTIAL: 'Pago parcial', PAID: 'Pagada', VOID: 'Anulada' }

function receiptHtml(r: PublicReceipt): string {
  const rows = r.lines
    .map((l) => {
      const firstCell =
        l.lineType === 'freight'
          ? `<span class="guia">${l.guia ? `Guía ${esc(l.guia)}` : esc(l.description ?? FREIGHT_ES[l.freightType ?? 'AIR'])}</span>${l.tracking ? `<br><span class="sub">Tracking ${esc(l.tracking)}</span>` : ''}`
          : esc(l.description ?? 'Otro cargo')
      return `<tr>
      <td>${firstCell}</td>
      <td>${l.freightType ? esc(FREIGHT_ES[l.freightType]) : '—'}</td>
      <td class="num">${l.quantityLbs != null ? esc(l.quantityLbs) : '—'}</td>
      <td class="num">${usd(l.unitPrice)}</td>
      <td class="num">${usd(l.total)}</td>
    </tr>`
    })
    .join('')
  const date = r.issueDate ? new Date(r.issueDate).toLocaleDateString('es-NI', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'
  const agencyName = esc(r.agency.name)
  const logo = r.agency.logoUrl
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Factura #${esc(r.invoiceNumber)} — ${agencyName}</title>
<style>
  :root { --ink:#111; --muted:#6b7280; --line:#e5e7eb; --brand:#FF3B3F; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f3f4f6; color:var(--ink); font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .sheet { max-width:720px; margin:24px auto; background:#fff; padding:40px; border:1px solid var(--line); border-radius:12px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid var(--ink); padding-bottom:16px; margin-bottom:20px; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand img { height:48px; width:48px; object-fit:contain; border-radius:6px; }
  .brand .info { display:flex; flex-direction:column; }
  .brand .name { font-size:22px; font-weight:800; letter-spacing:-.02em; }
  .brand small { font-size:12px; font-weight:500; color:var(--muted); letter-spacing:0; }
  .brand .ruc { font-size:13px; font-weight:700; color:var(--ink); margin-top:2px; }
  .brand .address { font-size:11px; color:var(--muted); }
  .brand .phone { font-size:11px; color:var(--muted); }
  .meta { text-align:right; }
  .meta .n { font-size:24px; font-weight:800; }
  .meta .l { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .who { margin-bottom:20px; }
  .who .l { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .who .client-details { font-size:12px; color:var(--muted); margin-top:2px; }
  table { width:100%; border-collapse:collapse; margin-bottom:16px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); border-bottom:1px solid var(--line); padding:8px 6px; }
  td { padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  td .sub { font-size:11px; color:var(--muted); }
  td .guia { font-weight:600; }
  .num { text-align:right; white-space:nowrap; }
  .totals { margin-left:auto; width:260px; }
  .totals .row { display:flex; justify-content:space-between; padding:4px 0; }
  .totals .grand { border-top:2px solid var(--ink); margin-top:6px; padding-top:8px; font-size:18px; font-weight:800; }
  .foot { margin-top:28px; text-align:center; color:var(--muted); font-size:12px; }
  .actions { max-width:720px; margin:0 auto; text-align:right; }
  .btn { display:inline-block; margin:8px 0; padding:8px 16px; border:0; border-radius:8px; background:var(--brand); color:#fff; font-weight:600; cursor:pointer; }
  @media print { body { background:#fff; } .sheet { border:0; margin:0; border-radius:0; } .actions { display:none; } }
</style></head><body>
<div class="actions"><button class="btn" onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="sheet">
  <div class="top">
    <div class="brand">
      ${logo ? `<img src="${esc(logo)}" alt="${agencyName}">` : ''}
      <div class="info">
        <span class="name">${agencyName}</span>
        <small>Factura</small>
        ${r.agency.ruc ? `<div class="ruc">RUC: ${esc(r.agency.ruc)}</div>` : ''}
        ${r.agency.address ? `<div class="address">${esc(r.agency.address)}</div>` : ''}
        ${r.agency.phone ? `<div class="phone">${esc(r.agency.phone)}</div>` : ''}
      </div>
    </div>
    <div class="meta"><div class="l">Factura N.º</div><div class="n">${esc(r.invoiceNumber)}</div><div class="l">${esc(date)}</div></div>
  </div>
  <div class="who">
    <div class="l">Cliente</div>
    <div>${esc(r.clientName ?? '—')}</div>
    ${r.clientAddress ? `<div class="client-details">${esc(r.clientAddress)}</div>` : ''}
  </div>
  <table>
    <thead><tr><th>Guía / Concepto</th><th>Flete</th><th class="num">Libras</th><th class="num">P. unit.</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="row grand"><span>Total</span><span>${usd(r.total)}</span></div>
  </div>
  <div class="foot">Gracias por su preferencia · ${agencyName}</div>
</div>
</body></html>`
}

/** GET /billing/r/:token — public printable receipt. */
publicReceipt.get('/:token', async (c) => {
  const token = c.req.param('token')
  // Reject anything that isn't a UUID-shaped token before touching the DB.
  if (!/^[0-9a-f-]{16,64}$/i.test(token)) return c.text('Recibo no encontrado.', 404)
  const svc = new BillingService(getBillingRepo(c.env))
  const receipt = await svc.publicReceipt(token)
  if (!receipt) return c.text('Recibo no encontrado.', 404)
  return c.html(receiptHtml(receipt))
})

export { publicReceipt as publicReceiptRouter }
