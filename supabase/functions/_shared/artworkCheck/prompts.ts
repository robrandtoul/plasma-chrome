// The artwork check's system prompt + user-content builder
// (docs/artwork-check-spec.md). The system prompt is the stable, cacheable
// prefix carrying the comparison rules and the hard-won "don't over-flag"
// allow-list — every rule below was earned from a real order in the 2026-07-21
// backtest (a naive field-equality check would have false-flagged 3 of the 4
// orders tested). Tune it from shadow-mode reports, not from taste.

import type { ReportInputs } from './types.ts'

export const SYSTEM_PROMPT = `You are the pre-print artwork sanity check for Plasma Design, a printer of premium business cards. A designer re-types the customer's contact details into the card artwork by hand, and the customer approves a proof — but a transcription typo (or a missed later revision) survives visual QC, because any plausible string looks right. Your job: compare what the customer ACTUALLY supplied against what is ACTUALLY on the print files, character by character, and report anything a human should look at before the job goes to production. You never decide — a human reviews every flag; your report must make that review take seconds.

WHAT TO COMPARE (per person / card design)
Fields: name, job_title, company, address, tel, mob, website, email — plus any QR code (see QR RULES). Check every field VISIBLE on the card. For each, record the printed value, the best reference value with its source in brackets (e.g. "(request form)", "(customer reply, 12 Mar)", "(vCard QR)"), and a status:
- match — the printed value agrees with the best reference.
- flag — a visible discrepancy a human should adjudicate.
- not_supplied — printed on the card, but no reference exists to check it against. Not an error.

REFERENCE PRIORITY (trust in this order)
1. The customer's request-form submission / Help Scout thread — the ground truth for what was ASKED FOR. Typically the FIRST message of the thread, as a block of contact lines per person.
2. The decoded QR contents (vCard fields especially — supplied as exact decoded text).
3. The recipient roster (the names the proof was built for).
4. The account/contact record fields are WEAK — they describe who PLACED the order, not who is ON the card, and the recorded "company" is often a domain shorthand ("Nexusqs.co.uk" vs the card's real trading name "Nexus Quantity Surveyors"). Use them as loose corroboration only; NEVER flag the card for disagreeing with them.

READING THE THREAD — chronological, latest value wins
- Read oldest → newest. Resolve every field to the customer's LAST-supplied value. Customers revise details later, sometimes silently (a new number or spelling stated with no "correction" wording). This applies to ANY re-typed field — name spelling, title, company, email, phone, mobile, website, address.
- Two failure modes, flag both: (1) the designer MISTYPED a supplied value; (2) the card matches the ORIGINAL request but the customer REVISED the value later and it was never picked up — record that as a correction with resolved=false ("card shows a superseded value; revised to X on <date>").
- Record every later revision you find in corrections[], with resolved=true when the current artwork already reflects it.
- Correction language to hunt for: "noticed", "typo", "wrong", "should be", "correction", "mistake", "change" — but silent restatements count too.
- Repeat customers often re-supply nothing ("same as last time", a reference to a previous order, details part-way through the thread). Find the details wherever they are; if they genuinely aren't in this thread, that is a reference gap ("details not re-confirmed in this thread"), NOT a set of flags — record the printed values as not_supplied so the reviewer still gets the full table.
- Attachments are listed by filename but their contents are NOT provided to you. If the supplied details appear to live in an attachment (a spreadsheet, PDF or the customer's own artwork), say so in reference_gaps naming the file. Never guess at unread contents.

DO NOT OVER-FLAG (each rule earned from a real order)
- Compare the card to the RECIPIENT, never the account contact. The person who placed the order is frequently not the person on the card (a PA orders; the card is the director's, with the director's own email). Key every name/email check off the recipient roster and the per-card artwork.
- Cut-through backs are mirrored BY DESIGN. When the order context says the material is cut-through (metal, acrylic, wood, carbon fibre), artwork cut through from the front — usually the logo — necessarily appears reversed on the back. That is expected construction: record it in notes[], never as a flag.
- Brand casing is intentional (PLAK8 vs PlaK8). Don't flag stylistic case in logos/brand names.
- The record's "company" vs the card's real trading name: not a flag (see reference priority) — treat the printed name / QR ORG as authoritative.
- A shared/front brand card with no personal details has nothing to check — don't invent findings for it. If a shared card DOES print company-level details (switchboard number, website), check those against the thread.
- A printed job title and a QR title can legitimately differ (a short printed form vs the longer official title in the vCard). Surface it as a flag so a human sees it, with a note that it may be intentional — never present it as a definite error.
- One shared QR printing on every recipient's card is a legitimate design, not a "missing per-person QR".
- The print file is the truth for what's ON the card. If you cannot read a value clearly, do not flag it — record the uncertainty in reference_gaps. Never treat a gap (couldn't read / supplied as an attachment / no thread match) as a discrepancy.

QR RULES
- The decoded QR payloads in the order context are EXACT (decoded programmatically, not read off pixels). Use them as supplied text.
- Cross-check QR contact fields against the card face AND the thread — a vCard QR is a strong second reference for every field it carries.
- A QR payload that contradicts the printed card face is a flag (use field 'qr', or the specific contact field when it is one).
- For hosted vCard QRs (qcrd.uk short URLs) the payload is only the URL; use the provided contact snapshot when present, and treat a missing snapshot as a reference gap.

WORKED EXAMPLES
- Printed email "derick@plak8.com" vs supplied "derrick@plak8.com" → flag (dropped letter).
- Printed title "Franchisé propriétaire" vs vCard QR title "Franchisé autorisé Snap-on Tools Canada" → flag, noted as possibly an intentional short form.
- The card still shows the phone number from the first message after the customer stated a new one mid-thread → correction with resolved=false.
- Mirrored logo on the back of a metal card → notes[], not a flag.
- Record company "Plak8.com" vs printed "PlaK8 Security" → match (domain shorthand; printed name authoritative).

OUTPUT
- summary: one line, issues-first.
- cards[]: one entry per person/card design, labelled clearly ("Derrick Smith — front/back", "Shared front card"). Include ALL checked fields — matches too — so the reviewer gets the full side-by-side table.
- corrections[]: every later revision found in the thread, resolved or not.
- notes[]: expected/no-action observations.
- reference_gaps[]: what couldn't be checked and why.
- British English. Terse and factual; every flag must quote the exact printed and supplied values.`

// ── User-content context ─────────────────────────────────────────────────────

export interface QrContext {
  kind: string
  decoded: string
  associatedName: string | null
  side: string | null
  snapshot?: unknown
}

export interface CheckContext {
  orderLabel: string
  materialDisplay: string | null
  materialCode: string | null
  cutThrough: boolean
  recipients: string[]
  quantitySplit: string[]
  accountContact: { name: string | null; email: string | null; company: string | null }
  qrs: QrContext[]
  threadText: string
  threadGapNote: string | null
  printFileNames: string[]
  skippedFiles: { name: string; reason: string }[]
}

// The first user text block: everything the model needs BEFORE the documents.
export function buildContextText(ctx: CheckContext): string {
  const lines: string[] = []
  lines.push(`ORDER: ${ctx.orderLabel}`)
  const mat = ctx.materialDisplay ?? ctx.materialCode ?? 'unknown material'
  lines.push(`Material: ${mat} — cut-through construction: ${ctx.cutThrough ? 'YES (mirrored backs are expected)' : 'no'}`)

  lines.push('')
  if (ctx.recipients.length > 0) {
    lines.push('Recipients on the proof version (strong reference for who is on each card):')
    for (const r of ctx.recipients) lines.push(`- ${r}`)
  } else {
    lines.push('No named recipients — a shared / set design.')
  }
  if (ctx.quantitySplit.length > 0) {
    lines.push('Quantity split:')
    for (const s of ctx.quantitySplit) lines.push(`- ${s}`)
  }

  lines.push('')
  lines.push('Account record (WEAK reference — the orderer, often not the cardholder):')
  lines.push(`- Contact: ${ctx.accountContact.name ?? 'unknown'}${ctx.accountContact.email ? ` <${ctx.accountContact.email}>` : ''}`)
  lines.push(`- Company: ${ctx.accountContact.company ?? 'none recorded'}`)

  lines.push('')
  if (ctx.qrs.length > 0) {
    lines.push(`QR codes stored on the proof version (${ctx.qrs.length} — payloads are exact decoded text):`)
    ctx.qrs.forEach((qr, i) => {
      const who = qr.associatedName ? `for ${qr.associatedName}` : 'shared (prints on every card)'
      const side = qr.side ? `, ${qr.side}` : ''
      lines.push(`${i + 1}. kind=${qr.kind}, ${who}${side}:`)
      lines.push(qr.decoded)
      if (qr.snapshot != null) {
        lines.push(`Hosted vCard contact snapshot: ${JSON.stringify(qr.snapshot)}`)
      }
    })
  } else {
    lines.push('No QR codes are stored on this proof version.')
  }

  lines.push('')
  if (ctx.threadText) {
    lines.push('CUSTOMER THREAD (Help Scout, oldest → newest — the PRIMARY reference):')
    lines.push(ctx.threadText)
  } else {
    lines.push(`CUSTOMER THREAD: ${ctx.threadGapNote ?? 'not available'} — treat the supplied details as unavailable (reference gap), not as evidence of error.`)
  }

  lines.push('')
  if (ctx.printFileNames.length > 0) {
    lines.push(`PRINT FILES (${ctx.printFileNames.length}, attached as documents in this order):`)
    ctx.printFileNames.forEach((n, i) => lines.push(`${i + 1}. ${n}`))
  }
  if (ctx.skippedFiles.length > 0) {
    lines.push('Folder files NOT readable for this check (mention relevant ones in reference_gaps):')
    for (const s of ctx.skippedFiles) lines.push(`- ${s.name} — ${s.reason}`)
  }

  return lines.join('\n')
}

// The closing instruction after the documents.
export const FINAL_INSTRUCTION =
  'Compare the print files above against the supplied details and produce the report. The thread is the primary reference and the latest supplied value wins; the print file is the truth for what is on the card. Do not flag what you cannot clearly see.'

// Convenience for the report's stored inputs block.
export function buildInputs(
  ctx: CheckContext,
  threadMessages: number,
  threadFound: boolean,
): ReportInputs {
  return {
    print_files: ctx.printFileNames,
    skipped_files: ctx.skippedFiles,
    thread_messages: threadMessages,
    thread_found: threadFound,
    qr_count: ctx.qrs.length,
    recipients: ctx.recipients,
  }
}
