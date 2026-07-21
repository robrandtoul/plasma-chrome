// Help Scout attachment reading for the artwork check (Phase 2a of
// docs/artwork-check-spec.md). The first shadow batch showed the customer's
// ground truth frequently lives in attachments — a roster in Book1.xlsx, an
// order-form PDF, contact details inside the customer's own artwork — which
// Phase 1 could only report as reference gaps. This module picks WHICH
// attachments to read and routes each into model-ready content.
//
// Two hard rules, both deliberate:
//   * CUSTOMER-authored attachments only. Staff attachments are our own
//     outputs — proof exports, supplier hand-off copies — and reading them
//     would verify the card against itself (circular) while drowning the
//     model in near-duplicate images. They stay filename-only context.
//   * Unreadable ≠ absent. Anything skipped (type, size, budget, parse
//     failure) is reported by name so the model can keep it as an honest
//     reference gap.

import { bytesToBase64, type ContentBlock } from './anthropic.ts'
import type { ThreadLike } from './threadText.ts'

export interface AttachmentMeta {
  id: number
  filename: string
  mimeType: string
  size: number
  // ISO date of the message it rode on (chronology matters — latest wins).
  at: string
}

// What an attachment becomes in the model call. `document` = base64 PDF,
// `image` = base64 image, `text` = parsed spreadsheet/CSV content.
export type RoutedAttachment =
  | { kind: 'document'; name: string; at: string; bytes: Uint8Array }
  | { kind: 'image'; name: string; at: string; mediaType: string; bytes: Uint8Array }
  | { kind: 'text'; name: string; at: string; text: string }

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const ATTACHMENTS_MAX_COUNT = 8
// Attachments share the request with the print files (Anthropic caps a
// request at ~32 MB, and base64 expands 4/3): their raw budget is whatever
// the print files left of ~24 MB, capped at 8 MB.
export const ATTACHMENTS_MAX_TOTAL_BYTES = 8 * 1024 * 1024
export function attachmentBudget(printFilesRawBytes: number): number {
  return Math.max(0, Math.min(ATTACHMENTS_MAX_TOTAL_BYTES, 24 * 1024 * 1024 - printFilesRawBytes))
}

// The types we can turn into reference material, ranked: structured data
// (rosters, forms) first, then documents, then images, then artwork-as-PDF.
// Everything else (zips, fonts, videos) is listed as unreadable.
function typePriority(filename: string): number | null {
  const f = filename.toLowerCase()
  if (/\.(xlsx|xls|csv|tsv|txt)$/.test(f)) return 0
  if (/\.pdf$/.test(f)) return 1
  if (/\.(jpe?g|png|gif|webp)$/.test(f)) return 2
  if (/\.ai$/.test(f)) return 3
  return null
}

// Pick the customer-authored attachments worth fetching, oldest-first within
// priority (the request form is usually EARLY in the thread), under the count
// + per-file + budget caps. Returns the fetch list plus everything passed
// over, with reasons, so the report stays honest about what wasn't read.
export function pickAttachments(
  threads: ThreadLike[],
  printFilesRawBytes: number,
): { picks: AttachmentMeta[]; skipped: { name: string; reason: string }[] } {
  const metas: AttachmentMeta[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const t of threads) {
    const list = t._embedded?.attachments ?? []
    if (list.length === 0) continue
    if (t.state === 'draft') continue
    const isCustomer = t.createdBy?.type === 'customer'
    for (const a of list) {
      const name = (a.filename ?? '').trim()
      if (!name) continue
      if (!isCustomer) {
        // Staff attachments stay filename-only context (threadText already
        // lists them inline); not even worth a skip entry.
        continue
      }
      const meta: AttachmentMeta = {
        id: typeof (a as { id?: number }).id === 'number' ? (a as { id: number }).id : 0,
        filename: name,
        mimeType: ((a as { mimeType?: string }).mimeType ?? '').toLowerCase(),
        size: typeof (a as { size?: number }).size === 'number' ? (a as { size: number }).size : 0,
        at: t.createdAt ?? '',
      }
      if (meta.id === 0) {
        skipped.push({ name, reason: 'no attachment id' })
        continue
      }
      if (typePriority(name) === null) {
        skipped.push({ name, reason: 'not a readable type' })
        continue
      }
      if (meta.size > ATTACHMENT_MAX_BYTES) {
        skipped.push({ name, reason: 'over the size limit' })
        continue
      }
      metas.push(meta)
    }
  }

  metas.sort((a, b) => {
    const p = (typePriority(a.filename) ?? 9) - (typePriority(b.filename) ?? 9)
    if (p !== 0) return p
    return Date.parse(a.at || '0') - Date.parse(b.at || '0')
  })

  const budget = attachmentBudget(printFilesRawBytes)
  const picks: AttachmentMeta[] = []
  let total = 0
  for (const m of metas) {
    if (picks.length >= ATTACHMENTS_MAX_COUNT) {
      skipped.push({ name: m.filename, reason: 'attachment limit reached' })
      continue
    }
    if (total + m.size > budget) {
      skipped.push({ name: m.filename, reason: 'attachment size budget reached' })
      continue
    }
    picks.push(m)
    total += m.size
  }
  return { picks, skipped }
}

// ── Routing fetched bytes into model-ready content ──────────────────────────

function looksLikePdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

const IMAGE_MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

// Per-attachment cap on parsed text (spreadsheets can be huge; the contact
// roster the check needs never is).
export const ATTACHMENT_TEXT_CHAR_CAP = 15_000

// SheetJS loads per-runtime: the Deno edge runtime resolves the npm:
// specifier, the Node test harness the bare package (already a repo
// dependency). Both failing degrades the attachment to unreadable — never an
// error. Literal specifiers so bundlers can see them.
type XlsxLike = {
  read: (data: Uint8Array, opts: { type: 'array' }) => {
    SheetNames: string[]
    Sheets: Record<string, unknown>
  }
  utils: { sheet_to_csv: (sheet: unknown) => string }
}
let xlsxModule: XlsxLike | null | undefined
async function loadXlsx(): Promise<XlsxLike | null> {
  if (xlsxModule !== undefined) return xlsxModule
  try {
    xlsxModule = (await import('npm:xlsx@0.18.5')) as unknown as XlsxLike
  } catch {
    try {
      xlsxModule = (await import('xlsx')) as unknown as XlsxLike
    } catch {
      xlsxModule = null
    }
  }
  return xlsxModule
}

export async function parseSpreadsheet(filename: string, bytes: Uint8Array): Promise<string | null> {
  const lower = filename.toLowerCase()
  if (/\.(csv|tsv|txt)$/.test(lower)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim()
      return text ? text.slice(0, ATTACHMENT_TEXT_CHAR_CAP) : null
    } catch {
      return null
    }
  }
  const XLSX = await loadXlsx()
  if (!XLSX) return null
  try {
    const wb = XLSX.read(bytes, { type: 'array' })
    const parts: string[] = []
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim()
      if (csv) parts.push(wb.SheetNames.length > 1 ? `[sheet: ${sheetName}]\n${csv}` : csv)
    }
    const joined = parts.join('\n\n').trim()
    return joined ? joined.slice(0, ATTACHMENT_TEXT_CHAR_CAP) : null
  } catch {
    return null
  }
}

// Route one fetched attachment. Null = unreadable (caller records the skip).
export async function routeAttachment(
  meta: AttachmentMeta,
  bytes: Uint8Array,
): Promise<RoutedAttachment | null> {
  const lower = meta.filename.toLowerCase()
  if (/\.(xlsx|xls|csv|tsv|txt)$/.test(lower)) {
    const text = await parseSpreadsheet(meta.filename, bytes)
    return text ? { kind: 'text', name: meta.filename, at: meta.at, text } : null
  }
  if (/\.pdf$/.test(lower) || /\.ai$/.test(lower)) {
    // .ai rides the same PDF-compatibility rule as the print files.
    if (!looksLikePdfBytes(bytes)) return null
    return { kind: 'document', name: meta.filename, at: meta.at, bytes }
  }
  const ext = lower.match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  const mediaType = IMAGE_MEDIA[ext]
  if (mediaType) {
    return { kind: 'image', name: meta.filename, at: meta.at, mediaType, bytes }
  }
  return null
}

// Short YYYY-MM-DD for content labels; empty-safe.
export function attachmentDateLabel(at: string): string {
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'unknown date'
}

// Turn routed attachments into content blocks: each gets a labelling text
// block (filename + date — images carry no title of their own), then its
// payload. Parsed spreadsheets fold label + contents into one text block.
export function routedToBlocks(routed: RoutedAttachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  routed.forEach((r, i) => {
    const label = `Customer attachment ${i + 1}/${routed.length}: "${r.name}" (sent ${attachmentDateLabel(r.at)})`
    if (r.kind === 'text') {
      blocks.push({ type: 'text', text: `${label} — parsed contents:\n${r.text}` })
      return
    }
    blocks.push({ type: 'text', text: `${label}:` })
    if (r.kind === 'document') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(r.bytes) },
        title: r.name,
      })
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: r.mediaType, data: bytesToBase64(r.bytes) },
      })
    }
  })
  return blocks
}
