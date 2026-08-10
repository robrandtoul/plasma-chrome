// Re-engagement: what a past customer sees when the Reorder desk brings them
// back (migrations 000389 / 000392).
//
// The customer page is built for someone who ASKED — they commissioned work,
// they have been waiting, and the page's central act is approving it. A past
// customer we approached is in the opposite position: they didn't ask, they
// may not remember us clearly, and the artwork isn't new work to judge — it is
// their own card, which they approved years ago and have in a drawer. Opening
// with "do you approve this design?" asks for a commitment before the
// relationship has been re-established, about the one thing not in question.
//
// So the band this module backs does three things instead:
//   1. Recognition — names when we last made their cards, which anchors memory
//      and proves we are their actual supplier rather than a stranger.
//   2. A 20-second task — check the printed details are still right. Details
//      going stale (a promotion, a new number, a moved office) is the usual
//      real reason a repeat customer needs cards, and finding one converts
//      "maybe later" into "actually, yes".
//   3. Lower rungs than Approve — "something needs updating" and "not right
//      now", both of which are wins: the first is a live conversation, the
//      second is information that stops the chase.
//
// ⚠ Everything here is customer-visible. buildReengagementContext is an
// ALLOW-LIST, not a filter: the register row it reads from carries scores,
// lifetime value and internal notes, none of which may ever cross into the
// stored snapshot. Same discipline as previousSpec.ts (000364).

import {
  chooserGuidance,
  previousBadgeText,
  quantityHint,
  type ChooserKind,
  type PreviousSpec,
} from './previousSpec'

/** The display-safe snapshot stored on proofs.reengagement_context. */
export interface ReengagementContext {
  /** ISO date (YYYY-MM-DD) of their most recent order. */
  last_order_on?: string
  /** How many times they have ordered from us before. */
  orders_count?: number
  /** Sentence-ready phrase for what they last bought, e.g. "500 translucent
   *  plastic cards (760 micron)" (000393). Absent when the source invoice
   *  carried more than one product line — see buildReengagementContext. */
  last_spec?: string
  // ── What they bought, in pointable pieces ─────────────────────────────────
  // last_spec is a sentence; these four are the same purchase expressed as
  // things the page can point AT — the quantity row in the price grid, the
  // thickness column, the matching row of the thickness guide. Stored
  // separately rather than parsed back out of the phrase, because parsing a
  // sentence to decide what to highlight is exactly how a customer ends up
  // with a tint on the wrong column.
  /** How many cards were on that order. */
  last_qty?: number
  /** material_variants.id of the thickness they had. Matching is by ID, never
   *  by label — see previousSpec.ts, whose rules this feature reuses. */
  last_variant_id?: string
  /** The variant's label FROZEN at capture ("500 micron"), so a later rename
   *  or retirement can still be named in the "not available" explainer. */
  last_variant_label?: string
  /** materials.id of what they bought. The refusal key: a tinted "760 micron"
   *  column on a steel proof, because they once bought plastic, is worse than
   *  no marker at all. */
  last_material_id?: string
}

// A spec phrase is built from a catalogue item name, so it should be short.
// The cap is a guard against a pathological free-text description reaching a
// customer's page as a wall of words, not a formatting rule.
const MAX_SPEC_LENGTH = 120

/** The register row the desk builds the snapshot from. Typed loosely on
 *  purpose — the point of the allow-list is that extra fields are ignored. */
interface ProspectLike {
  last_order_on?: string | null
  orders_count?: number | null
  last_spec?: string | null
  last_qty?: number | null
  last_variant_id?: string | null
  last_variant_label?: string | null
  last_material_id?: string | null
  [key: string]: unknown
}

// Caps mirror previousSpec.ts's server sanitiser: ids are uuids (36), labels
// are catalogue names. Both are read back off an anon-facing payload, so the
// bounds are enforced on the way out as well as the way in.
const MAX_ID_LENGTH = 64
const MAX_VARIANT_LABEL_LENGTH = 120
const MAX_QTY = 1_000_000

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Build the customer-visible snapshot from a register row. Returns null when
 * there is nothing honest to say, in which case no band is shown at all —
 * an empty greeting is worse than none.
 *
 * Deliberately NOT a spread-and-delete: every field is named, so a future
 * column on the register (a score, a note, a value) cannot leak by default.
 */
export function buildReengagementContext(prospect: ProspectLike): ReengagementContext | null {
  const out: ReengagementContext = {}

  const last = prospect.last_order_on
  if (typeof last === 'string' && ISO_DATE.test(last.slice(0, 10))) {
    out.last_order_on = last.slice(0, 10)
  }

  const count = prospect.orders_count
  if (typeof count === 'number' && Number.isInteger(count) && count > 0) {
    out.orders_count = count
  }

  const spec = prospect.last_spec
  if (typeof spec === 'string') {
    const trimmed = spec.trim()
    if (trimmed.length > 0 && trimmed.length <= MAX_SPEC_LENGTH) out.last_spec = trimmed
  }

  const qty = prospect.last_qty
  if (typeof qty === 'number' && Number.isInteger(qty) && qty > 0 && qty <= MAX_QTY) {
    out.last_qty = qty
  }

  const variantId = idField(prospect.last_variant_id)
  if (variantId) out.last_variant_id = variantId

  const variantLabel = prospect.last_variant_label
  if (typeof variantLabel === 'string') {
    const trimmed = variantLabel.trim()
    if (trimmed.length > 0 && trimmed.length <= MAX_VARIANT_LABEL_LENGTH) {
      out.last_variant_label = trimmed
    }
  }

  const materialId = idField(prospect.last_material_id)
  if (materialId) out.last_material_id = materialId

  // ⚠ The gate is deliberately the three SAYABLE fields only. The four
  // pointing fields describe where to put a marker, not anything the band can
  // say — a snapshot carrying nothing but a variant id would open with
  // "welcome back" and then fail to name when we last made their cards, which
  // is the one thing that proves we are their real supplier. An empty
  // greeting is worse than none.
  return out.last_order_on || out.orders_count || out.last_spec ? out : null
}

/** A uuid-ish identifier field: a non-empty string within the id cap. */
function idField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : null
}

/**
 * Read the snapshot back off the RPC payload. Tolerant by design: the key is
 * absent on every ordinary proof and on any deployment predating 000392, and a
 * malformed value must degrade to "not outreach" rather than throw on a
 * customer's page.
 */
export function parseReengagementContext(raw: unknown): ReengagementContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return buildReengagementContext(raw as ProspectLike)
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "2024-03-18" → "March 2024". Month precision only: the exact day is noise,
 *  and a wrong-looking day invites a dispute the sentence doesn't need. */
export function formatOrderMonth(iso: string): string | null {
  if (!ISO_DATE.test(iso.slice(0, 10))) return null
  const [y, m] = iso.slice(0, 10).split('-')
  const month = MONTHS[Number(m) - 1]
  return month ? `${month} ${y}` : null
}

/**
 * The recognition line — the highest-value sentence on the page for this
 * audience. Only claims what the snapshot actually knows.
 */
// Words in a material name that carry no identity of their own, so matching on
// them would pair any card with any other.
const MATERIAL_STOPWORDS = new Set(['card', 'cards', 'the', 'and', 'with'])

// The catalogue's one genuine synonym: the material is "Acrylic (Perspex)" and
// the invoices say "perspex cards".
const MATERIAL_SYNONYMS: Record<string, string[]> = {
  acrylic: ['perspex'],
  perspex: ['acrylic'],
}

/**
 * Does the remembered purchase plausibly describe the artwork on the page?
 *
 * The spec comes from the customer's most recent INVOICE; the page shows
 * whatever the designer rebuilt from the archive, and nothing reconciles the
 * two. A customer who bought steel in 2019 and plastic last year gets a steel
 * proof (that's the artwork we hold) — and telling them "it's exactly as we
 * last printed it, you last ordered 500 translucent plastic cards" above a
 * steel card is two true facts arranged into a false impression.
 *
 * So the spec is only spoken when the material it names is the material on
 * screen. Deliberately generous in one direction only: an unrecognised pairing
 * suppresses the spec and the date-only sentence stands, which is always true.
 * Under-claiming costs a nice sentence; over-claiming costs the trust the
 * whole band exists to build.
 */
export function specMatchesMaterial(
  spec: string | null | undefined,
  materialDisplay: string | null | undefined,
): boolean {
  if (!spec) return false
  // Nothing to contradict: a version with no material (a per-direction
  // Selection) makes no competing claim, so the spec stands on its own.
  if (!materialDisplay) return true

  const haystack = spec.toLowerCase()
  const words = materialDisplay
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !MATERIAL_STOPWORDS.has(w))

  if (words.length === 0) return true

  return words.some((w) =>
    [w, ...(MATERIAL_SYNONYMS[w] ?? [])].some((candidate) =>
      new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack),
    ),
  )
}

export function recognitionLine(
  ctx: ReengagementContext,
  opts: { materialDisplay?: string | null } = {},
): string {
  const when = ctx.last_order_on ? formatOrderMonth(ctx.last_order_on) : null
  // Only speak the purchase when it describes what's on the page.
  const spec = specMatchesMaterial(ctx.last_spec, opts.materialDisplay) ? ctx.last_spec : null
  const repeat = (ctx.orders_count ?? 0) >= 2
  // "You LAST ordered" asserts a series. A one-time customer is told plainly
  // what they ordered instead — the same distinction the date-only branches
  // have always drawn, which the first spec draft bypassed by sitting above
  // them and ignoring orders_count.
  const ordered = repeat ? 'You last ordered' : 'You ordered'

  // With the spec, split into two sentences rather than one long clause — the
  // combined form runs to about 25 words and reads like a receipt.
  if (spec && when) {
    return `This is the design we made for you. ${ordered} ${spec} in ${when}.`
  }
  if (spec) {
    return `This is the design we made for you — ${spec}${repeat ? ' last time' : ''}.`
  }
  if (when && repeat) {
    return `This is the design we made for you — you last ordered it in ${when}.`
  }
  if (when) {
    return `This is the design we made for you, back in ${when}.`
  }
  return 'This is the design we made for you.'
}

/** One quiet line acknowledging a long-standing customer, or null. Kept
 *  separate from the recognition line so a first-time repeat isn't flattered
 *  with a number that reads as marketing. */
export function historyLine(ctx: ReengagementContext): string | null {
  const n = ctx.orders_count ?? 0
  if (n < 3) return null
  return `You've ordered from us ${n} times — thank you.`
}

// ── Pointing at what they bought last time ──────────────────────────────────
//
// The band SAYS what they last ordered; these helpers let the page POINT at it
// — the thickness column in the price grid, the quantity row, the matching row
// of the thickness guide. All three markers are rendered by previousSpec.ts,
// the module the pay pages have used since 000364: it already knows to match
// on ids rather than labels, to word a retired option as "isn't available on
// this order" rather than "we no longer offer", to stand our own "Most
// popular" badge down while a customer's own history is showing, and to leave
// quantity as a static line rather than a nudge. Re-deriving any of that here
// would give a returning customer two different answers on two pages.

/**
 * May we mark anything at all?
 *
 * The refusal is the important half. The remembered purchase comes from the
 * customer's INVOICE; the page shows whatever the designer rebuilt from the
 * archive, and nothing reconciles the two — the same gap specMatchesMaterial
 * exists to close for the recognition sentence. A marker is a stronger claim
 * than a sentence, though: a tint down the "760 micron" column of a steel
 * proof doesn't just mention plastic, it asserts that THIS grid cell is what
 * they had. So this is stricter than the sentence's fuzzy word match — the
 * material must be known on both sides and be the same row of the catalogue.
 * An absent id is a refusal, not a pass: unknown is not the same as matching.
 */
export function reengagementMatchesMaterial(
  ctx: ReengagementContext | null | undefined,
  materialId: string | null | undefined,
): boolean {
  if (!ctx?.last_material_id || !materialId) return false
  return ctx.last_material_id === materialId
}

/**
 * The snapshot expressed as previousSpec.ts's PreviousSpec, or null when
 * nothing may be marked. Returns null on a material mismatch, so a caller
 * that forgets the guard still gets no markers rather than wrong ones.
 *
 * option_id / option_label stay null: the register knows the thickness they
 * bought but not which artwork finish tab it was proofed under, and inventing
 * a finish match would badge a tab at random.
 */
export function previousSpecFromReengagement(
  ctx: ReengagementContext | null | undefined,
  opts: { materialId?: string | null } = {},
): PreviousSpec | null {
  if (!ctx) return null
  if (!reengagementMatchesMaterial(ctx, opts.materialId)) return null

  const variantId = ctx.last_variant_id ?? null
  // ⚠ The label rides with the id or not at all, and this is the important
  // half. 000399 deliberately stores last_variant_label even when no catalogue
  // variant resolves — on live, 2,263 rows carry a label and only 1,039 an id —
  // because the label is the only record of what a customer actually bought
  // when the thing they bought has since been retired, or was never a variant
  // to begin with ("900gsm" letterpress, "3mm thick" perspex, both priced by
  // ink count). That is right for the REGISTER, but a bare label is useless to
  // a MARKER: nothing in it says which dimension it described, so previousSpec
  // reads "label present, id not among the offered ids" as retired-or-not-
  // offered and prints "your last order was 760 micron, which isn't available
  // on this order — the thicknesses above are the current options" over a grid
  // whose columns are ink counts. On live that fires for 822 rows against
  // roughly 25 legitimate ones.
  //
  // The trade-off, stated plainly: a genuinely retired variant whose id was
  // nulled by the FK's ON DELETE SET NULL loses its explainer, and the customer
  // simply sees no note. That is a smaller harm by two orders of magnitude than
  // telling 822 customers something false about their own order — and the
  // sentence in the band still names what they bought either way.
  const variantLabel = variantId ? (ctx.last_variant_label ?? null) : null
  const quantity = ctx.last_qty ?? null
  // Nothing to point at — same rule parsePreviousSpec applies to its own
  // payload. The band still shows; it just has no marker to place. (No
  // separate label test: the line above makes a label without an id
  // impossible, so an id-less snapshot is markable only by quantity.)
  if (!variantId && quantity == null) return null

  return {
    variant_id: variantId,
    variant_label: variantLabel,
    option_id: null,
    option_label: null,
    quantity,
    // Feeds previousBadgeText → "Your last order · March 2024". Month
    // precision, exactly as the recognition line speaks it.
    label: ctx.last_order_on ? formatOrderMonth(ctx.last_order_on) : null,
    source: 'auto',
  }
}

// ── One decision, read by every surface ─────────────────────────────────────

/**
 * What a price grid's columns actually ARE — material_variants.variant_type.
 *
 * ⚠ This is the field the first cut of this feature forgot existed. A proof's
 * grid is columned by whatever dimension its material is priced on: metal by
 * thickness, Standard Paper by finish, and Translucent / Satin Plastic and
 * Letterpress by INK COUNT, whose headers read "2 Inks", "3 Inks". Assuming
 * thickness makes every sentence written about those columns false.
 */
export type VariantDimension = 'thickness' | 'ink_count' | 'finish' | 'default'

/**
 * The single dimension a set of grid columns represents, or null.
 *
 * Null on an empty grid, on a mixed one, and on any type this module cannot
 * name honestly — including a variant row the page failed to resolve, which
 * arrives here as undefined. Refusing is the safe answer in all three cases:
 * no marker costs a nicety, a marker that names the wrong dimension costs the
 * trust the whole band is built on.
 */
export function variantDimension(
  types: readonly (string | null | undefined)[],
): VariantDimension | null {
  if (types.length === 0) return null
  const distinct = new Set(types)
  if (distinct.size !== 1) return null
  const only = [...distinct][0]
  return only === 'thickness' || only === 'ink_count' || only === 'finish' || only === 'default'
    ? only
    : null
}

/**
 * Which of previousSpec.ts's choosers, if any, can speak about this grid.
 *
 * ⚠ Never hard-code the kind at a call site. It picks BOTH the field read off
 * the spec and the noun printed in the explainer, so a hard-coded 'thickness'
 * silently narrates an ink-count grid as though it were thicknesses.
 *
 * 'ink_count' and 'default' get no chooser at all: the module has no wording
 * for them, and inventing some here would put the two pages out of step. A
 * finish-columned grid resolves to the finish chooser, which for a re-engaged
 * customer marks nothing today — the register remembers the VARIANT they
 * bought, never which finish option it was, and guessing would badge a column
 * at random. Under-claiming, deliberately.
 */
function chooserKindFor(dimension: VariantDimension | null): ChooserKind | null {
  if (dimension === 'thickness') return 'thickness'
  if (dimension === 'finish') return 'finish'
  return null
}

/**
 * Everything the page may mark for a returning customer, decided ONCE.
 *
 * ⚠ The single-decision part is the point, not tidiness. The price grid and
 * the thickness guide describe the same purchase on the same screen, and while
 * each derived its own answer they could disagree — the guide matched microns
 * parsed out of the remembered label and never consulted the ids the grid
 * renders, so a designer curating the grid down (displayed_variant_ids) got a
 * guide badging "300µm" directly beneath a grid saying "300 micron isn't
 * available on this order". Two confident, contradictory statements about the
 * customer's own history. Now the guide can only badge what the grid badged.
 */
export interface PreviousOrderMarkers {
  /** The grid column (material_variants.id) to badge and tint, or null. */
  badgeId: string | null
  /** Dated chip — "Your last order · March 2024". For roomy surfaces (the
   *  thickness guide's rows), and null whenever badgeId is. */
  badgeText: string | null
  /** Undated chip — "Your last order". The grid's cells are 70-110px wide in
   *  the left rail, where the dated form wraps to four lines or forces a
   *  sideways scroll; the date is already said twice elsewhere on the page.
   *  Set whenever there is a purchase at all, since the quantity row carries
   *  this chip even when no column is badged. */
  badgeTextShort: string | null
  /** The FROZEN label of the badged purchase ("500 micron"), for surfaces that
   *  match on prose rather than ids — the thickness guide's "500µm" rows.
   *  Frozen rather than the column's current display so a renamed variant
   *  still finds its row; null whenever badgeId is, which is what stops the
   *  guide claiming a thickness the grid says isn't available. */
  badgeLabel: string | null
  /** The under-grid explainer, or null. */
  note: string | null
  /** The quantity row to mark. */
  quantity: number | null
  /** The line that states the quantity when no row carries the marker. */
  quantityNote: string | null
}

const NO_MARKERS: PreviousOrderMarkers = {
  badgeId: null,
  badgeText: null,
  badgeTextShort: null,
  badgeLabel: null,
  note: null,
  quantity: null,
  quantityNote: null,
}

/**
 * Resolve the markers for one proof's price grid.
 *
 * `offeredVariantIds` are the columns the grid is actually rendering (after
 * the designer's displayed_variant_ids curation and the drop of variants with
 * no priced tier in this currency), and `dimension` is what those columns are.
 *
 * The quantity marker is decided independently of all of it and survives every
 * refusal below: a number of cards means the same thing whatever the columns
 * are, and on a single-column proof — paper, wood, acrylic, carbon fibre, and
 * every ink-count material — it is the only marker there is.
 */
export function previousOrderMarkers(
  spec: PreviousSpec | null,
  opts: {
    offeredVariantIds: readonly string[]
    dimension: VariantDimension | null
  },
): PreviousOrderMarkers {
  if (!spec) return NO_MARKERS

  const base: PreviousOrderMarkers = {
    ...NO_MARKERS,
    quantity: spec.quantity ?? null,
    badgeTextShort: previousBadgeText({ ...spec, label: null }),
    quantityNote: quantityHint(spec),
  }

  const kind = chooserKindFor(opts.dimension)
  if (!kind) return base

  const guidance = chooserGuidance(kind, spec, [...opts.offeredVariantIds], null)
  const frozenLabel = kind === 'thickness' ? spec.variant_label : spec.option_label
  return {
    ...base,
    badgeId: guidance.badgeId,
    badgeText: guidance.badgeId ? guidance.badgeText : null,
    badgeLabel: guidance.badgeId ? frozenLabel : null,
    note: guidance.note,
  }
}

// Thickness labels are written two ways in this codebase: the catalogue's
// variants read "500 micron" and the customer-facing thickness guide reads
// "500µm" (with either the micro sign µ or a Greek mu μ, depending who typed
// it). Compare the NUMBER rather than normalising the string, which sidesteps
// the two look-alike characters entirely — but insist on a micron unit being
// present, so a "3mm" label can never match a "3" of anything else.
const MICRON_LABEL = /(\d[\d,]*)\s*(?:µm|μm|um|microns?)\b/i

function micronsFromLabel(label: string | null | undefined): number | null {
  if (!label) return null
  const m = MICRON_LABEL.exec(label)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The thickness-guide rows the customer proof page should render: the row they
 * last bought carries "Your last order · March 2024", and NOTHING else carries
 * a badge.
 *
 * ⚠ The stripping is not incidental. The shared catalogue copy ships a "Most
 * popular" badge on one row for the pay-page chooser, and the proof-page guide
 * has never rendered badges at all — so a naive "render opt.badge" would put a
 * recommendation on every metal proof in the system, nudging customers about a
 * thickness their designer already chose. It would also break previousSpec's
 * suppressCatalogueBadges rule outright by sitting a "Most popular" on one row
 * and the customer's own history on another. One badge, or none.
 *
 * Generic over the row shape so this module stays free of the thickness-notes
 * catalogue; the guide's ThicknessOption satisfies it structurally.
 *
 * ⚠ It takes the GRID'S decision, not the raw spec, and re-deriving one here
 * would reintroduce the bug this signature exists to close: the guide used to
 * match microns out of the remembered label without ever consulting the ids the
 * grid renders, so a curated grid (displayed_variant_ids) produced a guide
 * badging "300µm" above a grid saying "300 micron isn't available on this
 * order". Whatever the grid badged, the guide may badge; nothing else.
 *
 * The remaining match IS by label, because a guide row is shared prose with no
 * catalogue id to compare against — but it is now a second filter on an
 * already-resolved decision rather than the decision itself, and the label it
 * matches is the frozen one, so a renamed variant still finds its row.
 */
export function previousOrderThicknessRows<T extends { label: string; badge?: string }>(
  options: T[],
  markers: PreviousOrderMarkers | null,
): T[] {
  const wanted = markers?.badgeId ? micronsFromLabel(markers.badgeLabel) : null
  const match = wanted == null ? undefined : options.find((o) => micronsFromLabel(o.label) === wanted)
  const badge = match ? markers?.badgeText ?? null : null
  return options.map((o) => ({ ...o, badge: badge && o === match ? badge : undefined }))
}

/**
 * What's most likely to have gone stale, named ON the action that does
 * something about it.
 *
 * This used to be a standalone tick-list above the artwork. It was cut: the
 * ticks reached nobody and gated nothing, so a customer who ticked them all
 * could reasonably believe they had told us the details were right when they
 * had told us nothing — a checkbox promises consequence. The value was never
 * in the ticking, it was in naming what to look at, and named here it sits
 * against the button that acts on it.
 *
 * The QR clause only appears when the artwork carries one: it's the single
 * item a customer cannot verify by squinting at the card in their hand, and a
 * QR pointing somewhere dead is worse than no QR at all.
 */
export function changeHelp(opts: { hasQrCodes: boolean }): string {
  const fields = opts.hasQrCodes
    ? 'Names, job titles, phone numbers, addresses, or where the QR code goes'
    : 'Names, job titles, phone numbers, addresses'
  return `${fields} — tell us what's changed and we'll update it before printing.`
}

/**
 * Which of the two openings the customer pressed.
 *
 * ⚠ ONE request either way. The kind shapes the prompt they see and the first
 * line the designer reads; it does not fork the mechanism. `claim_reorder_request`
 * is a single-row claim over three columns on proofs.proofs with a 24-hour
 * cooldown in its own WHERE — so two buttons posting two claims would mean the
 * second one lands inside the window, loses the claim, and is answered with the
 * same cheerful "we've got that" while the customer's words go nowhere. Two
 * doors, one room.
 */
export type ReorderRequestKind = 'repeat' | 'new_person'

/** Copy the band renders. Held here so the tests pin the tone, and so the
 *  wording can be reviewed in one place rather than hunted through JSX. */
export const REENGAGEMENT_COPY = {
  eyebrow: 'Welcome back',
  heading: 'Your cards, ready when you are',
  // Deliberately short: recognitionLine directly above already says whose
  // design this is and when they last ordered it, and the rendered band showed
  // the two sentences saying the same thing twice. The second clause is
  // load-bearing: for a repeat customer the likeliest need isn't more of the
  // same cards, it's the same design for somebody who has since joined, and
  // nothing else on the page suggests we can do that.
  // States a fact rather than issuing an instruction. The earlier draft told
  // the customer "details move on — check these are still right", which
  // editorialises about their business and instructs an adult who didn't ask
  // to be instructed. "Exactly as we last printed it" is the genuinely useful
  // thing we know and they don't, and it gives them the reason to look
  // without being told to.
  intro:
    "It's exactly as we last printed it, ready to run again — for the same people, or for someone new.",

  // ── The two openings ──────────────────────────────────────────────────────
  // Both open the same short form. The band used to offer "Something needs
  // updating" and "Cards for someone new" side by side, and both scrolled to
  // the page's own Request-changes button — two doors to the same room, and no
  // door at all for the answer this whole page exists to collect. The note
  // field inside the form is where "something needs updating" now lives, which
  // is exactly what the ordinary reorder panel's note has always been for.
  repeatAction: 'Order these again',
  repeatHelp: 'Same cards, same design. Tell us how many and we’ll send a payment link.',
  newPersonAction: 'Cards for someone new',
  newPersonHelp: 'Same design, a different name — for someone who has joined since.',

  // ── The form ──────────────────────────────────────────────────────────────
  formHeading: 'How many would you like?',
  quantityLabel: 'Quantity',
  quantityHint: 'Roughly is fine — we’ll confirm the price before anything is charged.',
  // The hint under this one is changeHelp() rather than a constant — it names
  // what is most likely to have gone stale, and adds the QR clause only when
  // the artwork carries one. That sentence is where "Something needs updating"
  // went when it stopped being a tile.
  noteLabel: 'Anything changed?',
  submit: 'Send this to us',
  sending: 'Sending…',
  back: 'Back',
  error: 'That didn’t send. Please try again, or just reply to our email.',

  // ⚠ Load-bearing, and the reason the band may say "payment link" at all:
  // this page cannot take money and must never imply it has. The sentence is
  // the boundary stated plainly, and it costs nothing.
  reassurance:
    'Nothing has been ordered and nothing is being printed. This page stays here if you want another look.',

  // Two acknowledgements. `sent` is what a fresh submission gets. `already` is
  // what a RELOAD gets — a second colleague on the shared link, or the same
  // person coming back — and it must not read as a second confirmation of a
  // second request, because there is only ever one.
  sent: 'Thanks — that’s with us. We’ll come back to you shortly.',
  already: 'You’ve already told us — we’re on it, and we’ll come back to you shortly.',

  // The exit. Deliberately NOT a peer tile: an equal-weight box beside the two
  // buying actions invites the low-intent visitor to take it, and this visitor
  // is low-intent by construction — we started this conversation, not them.
  declineAction: 'Not right now',
  // No closing reassurance line beyond the one above. "Nothing is printed
  // until you say so" was answering a worry nobody has on a page whose every
  // control is a choice — and saying it unprompted plants the idea that
  // printing-without-asking is a thing that happens here.
} as const

/**
 * What the note box starts with.
 *
 * Empty for a plain repeat — an empty box is the honest prompt when there may
 * genuinely be nothing to say, and a pre-filled sentence would invent a change
 * the customer hasn't got.
 *
 * For the new-joiner path it names the three fields, because that is the whole
 * value of naming the path separately: not where it goes, but knowing what to
 * write when you get there. A first reply that carries all three is usually the
 * only reply needed.
 */
export function reorderNotePrefill(kind: ReorderRequestKind): string {
  return kind === 'new_person'
    ? 'Could we add cards for someone new? Their name, job title and contact details are:\n'
    : ''
}

/**
 * What the quantity box starts with.
 *
 * Their last quantity, when we know it. This is the one number the register
 * genuinely holds about them, it is almost always the right answer, and typing
 * a number on a phone is exactly where a mildly-interested visitor gives up.
 *
 * Returns '' rather than a guess when last_qty is absent — 2,758 register rows
 * carry a date and an order count, but not all carry a quantity, and an
 * invented default would be a confident claim about their own history.
 */
export function reorderQuantityPrefill(ctx: ReengagementContext): string {
  const q = ctx.last_qty
  return typeof q === 'number' && Number.isFinite(q) && q > 0 ? String(q) : ''
}

/**
 * Whether to hide the page's own Approve button.
 *
 * ⚠ This is a correctness fix, not a taste one. On an outreach proof, Approve
 * means nothing the customer intends and something we very much do not:
 * `syncProspectOutcomes` puts a prospect in `toConvert` on
 * `facts?.status === 'approved'` ALONE (src/lib/reorderDesk.ts) and writes
 * state='converted', which the register renders as "Ordered again" in green.
 * So one press of the page's most prominent control books a sale that does not
 * exist, drops the customer out of every follow-up bucket permanently, and
 * emails them that we'll be in touch about next steps.
 *
 * Semantically it was never right either: Approve means "I sign this off for
 * print", and the artwork is the one thing not in question — they approved it
 * years ago. What is open here is commercial, and the reorder request is the
 * mechanism that means that.
 *
 * v1 ONLY. The moment a designer replies with a revision the customer genuinely
 * IS reviewing work in progress, and approve/request-changes becomes the
 * correct pair for the first time. Request changes is never suppressed — it is
 * semantically fine here and it is the honest fallback if the request form
 * fails.
 */
/**
 * Whether the band should show its acknowledgement instead of the openings.
 *
 * ⚠ Deliberately NOT the ordinary panel's 24-hour `reorderRequestIsRecent`.
 * That window exists to re-arm a settled customer who might genuinely want a
 * second, separate reorder weeks later. Here the request is unanswered until a
 * designer acts on it, and re-showing "Order these again" to someone who asked
 * on Monday tells them we lost it — so the ask holds until the answer arrives,
 * which on this page means an order existing on the proof.
 *
 * Reads a plain timestamp rather than a live/expired notion, because the ask is
 * not a link and cannot lapse.
 */
export function reengagementRequestOnFile(opts: {
  requestedAt: string | null | undefined
  hasOrder: boolean
}): boolean {
  if (opts.hasOrder) return false
  if (!opts.requestedAt) return false
  return !Number.isNaN(Date.parse(opts.requestedAt))
}

export function suppressApproveForOutreach(opts: {
  context: ReengagementContext | null
  versionNumber: number | null | undefined
}): boolean {
  if (!opts.context) return false
  return opts.versionNumber === 1
}

/**
 * Whether the band should appear at all. Only on the CURRENT version of a live
 * outreach proof: once approved the page has its own celebration, and on an
 * older version the greeting would sit above artwork the customer is only
 * browsing.
 */
export function shouldShowReengagementBand(opts: {
  context: ReengagementContext | null
  proofStatus: string | null | undefined
  isCurrentVersion: boolean
}): boolean {
  if (!opts.context) return false
  if (!opts.isCurrentVersion) return false
  return opts.proofStatus !== 'approved' && opts.proofStatus !== 'abandoned'
}
