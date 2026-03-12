import type { ShipmentData, ShipmentEvent, ShipmentStatus } from '../types/index.js'

// ─── HTML Parser ──────────────────────────────────────────────────────────────
//
// Everest uses Classic ASP with a consistent (if ancient) HTML structure.
// The main tracking table always looks like:
//
//   <table id="Almacen..."> ... </table>
//
// This module provides a pure-TS parser that works in a Cloudflare Worker
// (no JSDOM, no Node.js – uses only Regex + string operations since the
// Worker runtime doesn't ship a DOM parser).
//
// When Playwright is integrated, it will extract the raw HTML block and
// pass it here for parsing (or directly to the AI parser as a fallback).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Regex patterns (tuned to Everest HTML) ──────────────────────────────────
const RE_TABLE_BLOCK =
    /<table[^>]*id=["']?Almacen[^>]*>([\s\S]*?)<\/table>/i

const RE_TD_VALUE = /<td[^>]*>([\s\S]*?)<\/td>/gi
const RE_STRIP_TAGS = /<[^>]+>/g
const RE_NORMALIZE_SPACE = /\s{2,}/g
const RE_DATE = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/
const RE_TIME = /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\b/i

// ─── Status inference ─────────────────────────────────────────────────────────
const STATUS_MAP: [RegExp, ShipmentStatus][] = [
    [/recib|entrada|ingres/i, 'received'],
    [/almac[eé]n|warehouse/i, 'at_warehouse'],
    [/tr[áa]nsito|en ruta|en camino/i, 'in_transit'],
    [/entrega|delivery|distribuc/i, 'out_for_delivery'],
    [/entregado|delivered|complet/i, 'delivered'],
    [/excep|retenid|hold|problem/i, 'exception'],
]

function inferStatus(text: string): ShipmentStatus {
    for (const [re, status] of STATUS_MAP) {
        if (re.test(text)) return status
    }
    return 'unknown'
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function clean(html: string): string {
    return html
        .replace(RE_STRIP_TAGS, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(RE_NORMALIZE_SPACE, ' ')
        .trim()
}

function extractCells(html: string): string[] {
    const cells: string[] = []
    let match: RegExpExecArray | null
    RE_TD_VALUE.lastIndex = 0
    while ((match = RE_TD_VALUE.exec(html)) !== null) {
        const text = clean(match[1])
        if (text) cells.push(text)
    }
    return cells
}

// ─── Main parser ──────────────────────────────────────────────────────────────
/**
 * Parses a raw HTML page from `everest.cargotrack.net` and returns a
 * structured `ShipmentData` object.
 *
 * If the HTML doesn't contain a recognisable shipment table, returns `null`.
 */
export function parseEverestHtml(
    html: string,
    trackingId: string,
): ShipmentData | null {
    // 1. Try to isolate the Almacen table block
    const tableMatch = RE_TABLE_BLOCK.exec(html)
    const targetHtml = tableMatch ? tableMatch[0] : html

    // 2. Extract all text cells from the table (or full page as fallback)
    const cells = extractCells(targetHtml)
    if (cells.length === 0) return null

    // 3. Build events by walking cell pairs (date/time + description pattern)
    const events: ShipmentEvent[] = []
    let lastStatus: ShipmentStatus = 'unknown'

    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        const dateMatch = RE_DATE.exec(cell)
        const timeMatch = RE_TIME.exec(cell)

        if (dateMatch) {
            // The next cell likely contains the description
            const description = cells[i + 1] ?? cell
            const status = inferStatus(description)
            lastStatus = status

            events.push({
                date: dateMatch[1],
                time: timeMatch ? timeMatch[1] : undefined,
                description,
                status,
            })

            // Skip the description cell we just consumed
            if (cells[i + 1]) i++
        }
    }

    // 4. Try to extract weight (pattern: "3.20 Lbs" or similar)
    const fullText = cells.join(' ')
    const weightMatch = /(\d+[\.,]\d+)\s*(lb|lbs|kg)/i.exec(fullText)

    return {
        trackingId,
        status: events.length > 0 ? lastStatus : 'unknown',
        events,
        weight: weightMatch ? `${weightMatch[1]} ${weightMatch[2].toLowerCase()}` : undefined,
        scrapedAt: Date.now(),
    }
}

// ─── AI Parsing Stub ──────────────────────────────────────────────────────────
/**
 * Future: pass the raw HTML block to GPT-4o-mini for structured extraction.
 * Enabled when OPENAI_API_KEY is present and the regex parser returns null.
 *
 * @param html     The raw HTML from the Almacen table
 * @param apiKey   OpenAI API key from Cloudflare secret
 */
export async function parseWithAI(
    html: string,
    apiKey: string,
): Promise<ShipmentData | null> {
    const prompt = `
You are a data extraction assistant. Below is raw HTML from an old Classic ASP logistics system.
Extract the shipment tracking information and return a JSON object with these fields:
{
  "trackingId": string,
  "warehouseId": string | null,
  "weight": string | null,
  "description": string | null,
  "origin": string | null,
  "destination": string | null,
  "status": "received" | "in_transit" | "at_warehouse" | "out_for_delivery" | "delivered" | "exception" | "unknown",
  "events": [{ "date": string, "time": string | null, "description": string, "location": string | null, "status": string }]
}
Return ONLY valid JSON, no markdown fences.

HTML:
${html.slice(0, 8000)}
`.trim()

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            response_format: { type: 'json_object' },
        }),
    })

    if (!response.ok) return null

    const payload = (await response.json()) as {
        choices: { message: { content: string } }[]
    }

    try {
        const content = payload.choices[0]?.message?.content
        if (!content) return null
        const parsed = JSON.parse(content) as ShipmentData
        parsed.scrapedAt = Date.now()
        return parsed
    } catch {
        return null
    }
}
