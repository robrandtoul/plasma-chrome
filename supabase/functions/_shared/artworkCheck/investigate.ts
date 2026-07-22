// Flag investigation — the designer-triggered escalation behind each flag
// (docs/artwork-check-spec.md). The primary check says WHAT disagrees; this
// answers WHEN it arose and WHOSE it is, by walking the flagged card's
// artwork across every proof version and lining the observed values up
// against the thread's dated instructions. Designers rarely write change
// notes, so the versions' ARTWORK is the source of truth for the walk.
//
// Deliberately scoped to ONE flag (one card, one field): that keeps an
// 8-version history to a handful of small images, and keeps the answer a
// focused timeline instead of an order-level essay. Runs only when a human
// clicks Investigate — never automatically.

export type InvestigationFault =
  | 'ours_transcription'
  | 'ours_missed_revision'
  | 'customer_origin'
  | 'undetermined'

export interface InvestigationTimelineEntry {
  // YYYY-MM-DD, or 'unknown' when a date genuinely can't be established.
  at: string
  kind: 'instruction' | 'version'
  // 'Customer' for instructions; 'v3' for versions.
  label: string
  detail: string
}

export interface Investigation {
  timeline: InvestigationTimelineEntry[]
  conclusion: string
  fault: InvestigationFault
  // Bookkeeping added by the function (not model output).
  card: string
  field: string
  at: string
  model: string
  usage: { input_tokens: number; output_tokens: number } | null
}

// One investigation per (card, field) — the report stores them keyed so a
// second designer opening the same flag sees the cached walk, not a re-run.
export function investigationKey(card: string, field: string): string {
  return `${card}::${field}`
}

// The report's card labels are MODEL-WRITTEN text ("Christine Davis — card",
// "Shared front card"), so mapping a flag back to a recipient's image rows
// needs fuzzy-but-safe matching: the recipient whose full name appears in the
// label, longest match winning so "Dave Allen-Smith" beats "Dave Allen" when
// both are on the roster. No recipient in the label → the shared artwork.
export function matchCardToRecipient(cardLabel: string, recipients: string[]): string | null {
  const label = cardLabel.toLowerCase()
  let best: string | null = null
  for (const r of recipients) {
    const name = r.trim()
    if (!name) continue
    if (label.includes(name.toLowerCase()) && (best === null || name.length > best.length)) {
      best = name
    }
  }
  return best
}

export interface VersionRowLite {
  id: string
  version_number: number
  created_at: string | null
  material_display: string | null
}

export interface VersionImageRowLite {
  proof_version_id: string
  image_path: string | null
  associated_name: string | null
  side: string | null
  is_qr_code?: boolean | null
}

export interface InvestigationImagePick {
  path: string
  // "v3 — back" so the model reads each image against its round.
  label: string
  versionNumber: number
  mediaType: string
}

export const INVESTIGATION_IMAGES_MAX = 20
export const INVESTIGATION_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const INVESTIGATION_TOTAL_MAX_BYTES = 16 * 1024 * 1024

const IMAGE_MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

// The flagged card's images across every version, oldest round first (the
// walk reads forward through time), front before back within a round. Named
// recipient → their rows; no recipient matched → the shared rows. QR rows and
// non-raster paths are skipped silently (they can't carry the field).
export function pickInvestigationImages(
  versions: VersionRowLite[],
  images: VersionImageRowLite[],
  recipient: string | null,
): InvestigationImagePick[] {
  const byVersion = new Map(versions.map((v) => [v.id, v]))
  const picks: InvestigationImagePick[] = []
  const candidates = images.filter((img) => {
    if (img.is_qr_code === true) return false
    if (!(img.image_path ?? '').trim()) return false
    if (!byVersion.has(img.proof_version_id)) return false
    return recipient === null
      ? img.associated_name == null
      : img.associated_name === recipient
  })
  candidates.sort((a, b) => {
    const va = byVersion.get(a.proof_version_id)?.version_number ?? 0
    const vb = byVersion.get(b.proof_version_id)?.version_number ?? 0
    if (va !== vb) return va - vb
    const as = (a.side ?? 'front') === 'front' ? 0 : 1
    const bs = (b.side ?? 'front') === 'front' ? 0 : 1
    return as - bs
  })
  for (const img of candidates) {
    if (picks.length >= INVESTIGATION_IMAGES_MAX) break
    const path = (img.image_path ?? '').trim()
    const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    const mediaType = IMAGE_MEDIA[ext]
    if (!mediaType) continue
    const v = byVersion.get(img.proof_version_id)
    picks.push({
      path,
      label: `v${v?.version_number ?? '?'} — ${img.side === 'back' ? 'back' : 'front'}`,
      versionNumber: v?.version_number ?? 0,
      mediaType,
    })
  }
  return picks
}

// ── Prompt + schema ──────────────────────────────────────────────────────────

export const INVESTIGATION_SYSTEM_PROMPT = `You are reconstructing the history of ONE flagged value on a business-card order, to establish WHEN it arose and WHOSE it is. You are given: the flag (card, field, printed value, best reference value, and the main check's note); the customer's Help Scout thread (dated, oldest → newest); and this card's artwork across every proof version, each image labelled with its round (v1, v2, …) and each round dated.

Build a single dated timeline merging two kinds of event:
- kind "instruction" — each customer message relevant to THIS value, quoting the operative words, dated.
- kind "version" — each proof round, stating exactly what the card shows for this field in that round ("v3 front: tel 0207 288 8008"). Read the artwork carefully; if a round's image doesn't show the field, or can't be read, say precisely that — never guess.

Then conclude ONE fault lean:
- ours_transcription — the value never matched any customer instruction; it was wrong from its first appearance on the artwork.
- ours_missed_revision — an earlier round matched what was asked, the customer then revised the instruction, and later rounds failed to pick the revision up (or the artwork was corrected and then regressed).
- customer_origin — every appearance faithfully matches what the customer supplied at the time; the problem originates in what they supplied (including a value that contradicts their own other materials, queried or not).
- undetermined — the images or thread genuinely don't pin it down.

Rules:
- Dates decide everything: an instruction only counts against rounds created AFTER it. A round cut before a revision cannot have "missed" it.
- Rendering and image-quality differences are not value changes.
- Never invent a clean story. If the artwork changed with no instruction explaining it, or the field is unreadable in some rounds, the timeline must say so and the fault may be undetermined.
- The conclusion is 2–4 plain-English sentences a non-designer can act on: what happened, when, and who should carry it.
- British English; quote exact values.`

export const INVESTIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['timeline', 'conclusion', 'fault'],
  properties: {
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at', 'kind', 'label', 'detail'],
        properties: {
          at: { type: 'string', description: 'YYYY-MM-DD, or "unknown".' },
          kind: { type: 'string', enum: ['instruction', 'version'] },
          label: { type: 'string', description: '"Customer" for instructions; "v3" for rounds.' },
          detail: { type: 'string' },
        },
      },
    },
    conclusion: { type: 'string' },
    fault: {
      type: 'string',
      enum: ['ours_transcription', 'ours_missed_revision', 'customer_origin', 'undetermined'],
    },
  },
} as const

export interface InvestigationTarget {
  card: string
  field: string
  printed: string
  supplied: string
  note: string
}

export function buildInvestigationContext(
  target: InvestigationTarget,
  versions: VersionRowLite[],
  recipient: string | null,
  threadText: string,
  threadGapNote: string | null,
): string {
  const lines: string[] = []
  lines.push('THE FLAG UNDER INVESTIGATION')
  lines.push(`Card: ${target.card}${recipient ? ` (recipient: ${recipient})` : ' (shared artwork)'}`)
  lines.push(`Field: ${target.field}`)
  lines.push(`Printed (current print file): ${target.printed}`)
  if (target.supplied) lines.push(`Best reference value: ${target.supplied}`)
  if (target.note) lines.push(`Main check's note: ${target.note}`)

  lines.push('')
  lines.push(`PROOF ROUNDS (${versions.length} — this card's artwork for each follows as images):`)
  for (const v of versions) {
    const when = v.created_at ? v.created_at.slice(0, 10) : 'unknown date'
    lines.push(`- v${v.version_number} — created ${when}${v.material_display ? ` — ${v.material_display}` : ''}`)
  }

  lines.push('')
  if (threadText) {
    lines.push('CUSTOMER THREAD (oldest → newest):')
    lines.push(threadText)
  } else {
    lines.push(`CUSTOMER THREAD: ${threadGapNote ?? 'not available'} — date the versions only; the fault may well be undetermined without it.`)
  }
  return lines.join('\n')
}

export const INVESTIGATION_FINAL_INSTRUCTION =
  'Walk the rounds in order against the dated instructions and produce the timeline, conclusion and fault lean. Do not invent what you cannot see.'
