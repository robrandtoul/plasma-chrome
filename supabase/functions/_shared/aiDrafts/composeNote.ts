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

  // note_summary is reserved for context the reviewer might MISS (see the
  // prompt) — empty on a clean draft, so no "what I did" narration is injected.
  const summary = (draft?.note_summary ?? '').trim()
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

// Whether this outcome warrants a Help Scout note at all. A clean draft — one
// with nothing to verify and no easily-missed context — gets NO note; the draft
// itself (plus the ai-draft tag) is the signal. A block always notes (the note
// is the only signal there). An abstention notes only with a handoff action or
// surfaced context, so silence stays a feature for the category/confidence gate.
export function shouldPostNote(input: ComposeNoteInput): boolean {
  const { outcome, draft, abstainOrBlockReason } = input
  const context = (draft?.note_summary ?? '').trim()
  if (outcome === 'blocked') return true
  if (outcome === 'abstained') {
    // A model-CONSIDERED abstention (draft present — e.g. a complaint or a
    // feasibility question it handed off) carries its reason in
    // abstainOrBlockReason; that handoff signal is the note's whole point, and
    // it's the only Help Scout footprint (no draft, no tag), so post it. The
    // pre-gate abstentions (category/confidence/artwork-form) have draft === null
    // and stay silent — silence is a feature there. Keep this in lockstep with
    // buildHtmlTerse's abstention branch, or the gate and renderer disagree.
    return draft?.action != null || context !== '' || (draft != null && (abstainOrBlockReason ?? '').trim() !== '')
  }
  if (outcome === 'drafted') return (draft?.checks?.length ?? 0) > 0 || context !== ''
  return false // skipped
}

// The Help Scout note: terse and human. No telemetry header, no figures dump,
// no self-congratulatory pass status — just what the reviewer needs to act on:
// context they might miss, a handoff action, assumptions, before-you-send
// checks, and (for a block/abstention) why there's no draft. Help Scout
// collapses newlines and renders <p> margins near-zero, so blocks are spaced
// with a <br>. The full working stays in the ledger text (the admin panel).
function buildHtmlTerse(input: ComposeNoteInput): string {
  const { draft, outcome, abstainOrBlockReason } = input
  const blocks: string[] = []
  const context = (draft?.note_summary ?? '').trim()
  if (context) blocks.push(`<p>${escapeHtml(context)}</p>`)
  if (draft?.action) blocks.push(`<p>${escapeHtml(draft.action)}</p>`)
  if (draft?.assumptions?.length) {
    blocks.push(`<p>Assumed: ${draft.assumptions.map(escapeHtml).join('; ')}</p>`)
  }
  if (draft?.checks?.length) {
    blocks.push(
      draft.checks.length === 1
        ? `<p><strong>Before you send:</strong> ${escapeHtml(draft.checks[0])}</p>`
        : `<p><strong>Before you send</strong></p><ul>${draft.checks.map((ch) => `<li>☐ ${escapeHtml(ch)}</li>`).join('')}</ul>`,
    )
  }
  if (outcome === 'blocked') {
    blocks.push(
      `<p style="color:#b91c1c">⚠ The AI couldn't send this itself (${escapeHtml(abstainOrBlockReason ?? 'a figure or link did not reconcile')}) — please reply by hand.</p>`,
    )
  } else if (outcome === 'abstained' && abstainOrBlockReason && !draft?.action) {
    blocks.push(`<p style="color:#555">${escapeHtml(abstainOrBlockReason)}</p>`)
  }
  // <br> spacer between blocks (Help Scout's <p> margins are near-zero).
  return blocks.map((b, i) => (i === 0 ? b : `<br>${b}`)).join('')
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

  // The Help Scout note is the terse, human form (no header/figures/pass line);
  // the full working above stays in the ledger text for the admin panel.
  const html = buildHtmlTerse(input)

  return { text, html }
}
