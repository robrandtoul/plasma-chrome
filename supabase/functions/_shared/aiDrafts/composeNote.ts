// Render the structured draft fields into the internal note the reviewer
// reads in Help Scout (and the panel). One consistent, scannable layout —
// header, summary, figures used, assumptions, a before-you-send checklist,
// the action, and the guardrail verdict — instead of free model prose.
//
// Returns both a plain-text form (stored in the ai_drafts.note_body ledger
// column; the panel shows it as-is) and an HTML form (posted to Help Scout,
// where newlines collapse so structure needs real markup).

import type { ClassifyResult, DraftResult, FigureUsed, GuardrailVerdict } from './types.ts'

export interface ComposeNoteInput {
  classification: ClassifyResult
  draft: DraftResult | null
  outcome: 'drafted' | 'abstained' | 'blocked' | 'skipped'
  abstainOrBlockReason: string | null
  guardrails: GuardrailVerdict | null
}

const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

// Plain-English stand-ins so the header reads like a colleague's note, not a
// row from the database. The raw category/outcome codes are internal jargon.
const CATEGORY_LABEL: Record<string, string> = {
  quote_request: 'Quote',
  lead_time: 'Lead time',
  capability_question: 'Capability question',
  sample_request: 'Sample request',
  order_details_collection: 'Order details',
  order_status: 'Order status',
  invoice_copy: 'Invoice copy',
  artwork: 'Artwork',
  complaint: 'Complaint',
  other: 'Other',
}

const OUTCOME_LABEL: Record<string, string> = {
  abstained: 'needs you',
  blocked: 'blocked',
  skipped: 'skipped',
}

function figureLine(f: FigureUsed): string {
  const sym = CURRENCY_SYMBOL[f.currency] ?? `${f.currency} `
  return `${sym}${f.amount} — ${f.source}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

interface Section {
  title: string
  // A plain paragraph, a bulleted list, or a checklist.
  kind: 'para' | 'bullets' | 'checks'
  items: string[]
}

function buildSections(input: ComposeNoteInput): { header: string; status: string | null; statusTone: 'ok' | 'warn' | 'info'; sections: Section[] } {
  const { classification: c, draft, outcome, abstainOrBlockReason, guardrails } = input
  const bits = [`AI · ${CATEGORY_LABEL[c.category] ?? c.category}`, `${c.confidence} confidence`]
  if (c.currency_hint && c.currency_hint !== 'unknown') bits.push(c.currency_hint)
  if (outcome !== 'drafted') bits.push(OUTCOME_LABEL[outcome] ?? outcome)
  const header = bits.join(' · ')

  const sections: Section[] = []

  const summary = draft?.note_summary || (outcome === 'skipped' ? '' : classifySummaryFallback(c))
  if (summary) sections.push({ title: '', kind: 'para', items: [summary] })

  if (draft?.action) sections.push({ title: 'Action', kind: 'para', items: [draft.action] })

  if (draft?.figures_used?.length) {
    sections.push({ title: 'Figures used', kind: 'bullets', items: draft.figures_used.map(figureLine) })
  }
  if (draft?.assumptions?.length) {
    sections.push({ title: 'Assumptions', kind: 'bullets', items: draft.assumptions })
  }
  if (draft?.checks?.length) {
    sections.push({ title: 'Before you send', kind: 'checks', items: draft.checks })
  }

  // Status line — the verdict, most prominent for a block.
  let status: string | null = null
  let statusTone: 'ok' | 'warn' | 'info' = 'info'
  if (outcome === 'blocked') {
    status = `BLOCKED before reaching you — ${abstainOrBlockReason ?? 'a figure or link did not reconcile'}`
    statusTone = 'warn'
  } else if (outcome === 'drafted') {
    status = (draft?.figures_used?.length ?? 0) > 0
      ? 'All figures reconciled against live pricing.'
      : 'Passed all checks.'
    statusTone = 'ok'
  } else if (outcome === 'abstained' && abstainOrBlockReason && !draft?.action) {
    status = abstainOrBlockReason
    statusTone = 'info'
  }

  return { header, status, statusTone, sections }
}

function classifySummaryFallback(c: ClassifyResult): string {
  return c.summary || ''
}

export function composeNote(input: ComposeNoteInput): { text: string; html: string } {
  const { header, status, statusTone, sections } = buildSections(input)

  // ── Plain text ──
  const textParts: string[] = [header, '']
  for (const s of sections) {
    if (s.title) textParts.push(`${s.title.toUpperCase()}`)
    for (const item of s.items) {
      const prefix = s.kind === 'checks' ? '☐ ' : s.kind === 'bullets' ? '• ' : ''
      textParts.push(`${prefix}${item}`)
    }
    textParts.push('')
  }
  if (status) {
    const mark = statusTone === 'ok' ? '✓ ' : statusTone === 'warn' ? '⚠ ' : ''
    textParts.push(`${mark}${status}`)
  }
  const text = textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // ── HTML (Help Scout collapses newlines, so each block needs real markup
  //    and each header needs its own line before the content beneath it) ──
  const htmlParts: string[] = [`<p><strong>${escapeHtml(header)}</strong></p>`]
  for (const s of sections) {
    if (s.kind === 'para') {
      const titleHtml = s.title ? `<strong>${escapeHtml(s.title)}</strong><br>` : ''
      htmlParts.push(`<p>${titleHtml}${s.items.map((i) => escapeHtml(i)).join('<br>')}</p>`)
    } else {
      const mark = s.kind === 'checks' ? '☐ ' : ''
      const titleHtml = s.title ? `<p><strong>${escapeHtml(s.title)}</strong></p>` : ''
      htmlParts.push(`${titleHtml}<ul>${s.items.map((i) => `<li>${mark}${escapeHtml(i)}</li>`).join('')}</ul>`)
    }
  }
  if (status) {
    const mark = statusTone === 'ok' ? '✓ ' : statusTone === 'warn' ? '⚠ ' : ''
    const colour = statusTone === 'warn' ? '#b91c1c' : statusTone === 'ok' ? '#166534' : '#555'
    htmlParts.push(`<p style="color:${colour}">${mark}${escapeHtml(status)}</p>`)
  }
  const html = htmlParts.join('')

  return { text, html }
}
