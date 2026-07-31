// Customer-facing order progress: the stages, their copy, and how many steps
// a given parcel's journey actually has.
//
// Shared because there are now two surfaces showing the same journey — the pay
// page's full rail and the proof page's compact strip (000371) — and they read
// the same projection. Presentation differs per surface; the LOGIC must not,
// or one page ends up telling a customer their cards are on the way while the
// other still says in production.
//
// ── Why the step count varies ───────────────────────────────────────────────
//
// Delivery is a carrier event, and only some carriers report it. On live at the
// time of writing, FedEx stamped 65 of its 70 shipped parcels; DPD — the UK
// domestic carrier, and roughly two thirds of all volume — has stamped exactly
// zero, ever. A fixed four-step rail therefore left most customers parked on
// "On its way" forever, watching a final step that was never going to light up.
//
// So the projection reports `delivery_tracked` (migration 000370) and the rail
// renders only the steps it can reach: four for a FedEx parcel, three for a DPD
// one. Both end in a state the journey can actually finish in, which is the
// entire point of a progress indicator.
//
// `delivery_tracked` is absent before dispatch (no carrier is assigned yet), and
// absence means "we don't know" — show the full journey until told otherwise.
// A stage that has already reached `delivered` forces the long form regardless,
// because the evidence is right there.

export type TrackingStage = 'paid' | 'in_production' | 'on_its_way' | 'delivered'

export type TrackingProjection =
  | { level: 'off' }
  | {
      level: 'broad' | 'granular'
      stage?: TrackingStage
      /** Absent = not dispatched yet, so unknown. See header. */
      delivery_tracked?: boolean
      /**
       * When the parcel actually went (migration 000375). The REAL dispatch
       * stamp, never the trigger that moved the stage — see that migration on
       * why in-house `completed_at` must not stand in for it. Absent before
       * dispatch, and absent afterwards if the stamp was never written.
       *
       * Unlike `tracking_number` this IS present on the proof page: a date is
       * inert, and nobody can act on a parcel with it.
       */
      shipped_at?: string
      /**
       * Pay page only. Deliberately NEVER present on the proof page's payload —
       * /p/:id is shared broadly and a tracking number lets its holder act on
       * the parcel, not just read about it (migration 000371 header).
       */
      tracking_number?: string
    }

export const TRACKING_STAGES: TrackingStage[] = ['paid', 'in_production', 'on_its_way', 'delivered']

export function isTrackingStage(v: unknown): v is TrackingStage {
  return typeof v === 'string' && (TRACKING_STAGES as string[]).includes(v)
}

// Headline + the one line that stands in for a static "what happens next" box,
// so it stays accurate on every visit rather than only right after payment.
export const STAGE_META: Record<TrackingStage, { label: string; line: string }> = {
  paid:          { label: 'Paid',          line: 'We’ve got your order and we’re preparing the artwork for the production team.' },
  in_production: { label: 'In production', line: 'Our workshop is producing your cards — we’ll email you the moment they’re on their way.' },
  on_its_way:    { label: 'On its way',    line: 'Your cards are on their way.' },
  delivered:     { label: 'Delivered',     line: 'Delivered — we hope they look great.' },
}

export interface TrackingStep {
  key: TrackingStage
  label: string
}

const FULL_STEPS: TrackingStep[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'in_production', label: 'In production' },
  { key: 'on_its_way', label: 'On its way' },
  { key: 'delivered', label: 'Delivered' },
]

// Same journey, minus a destination we'd never be able to confirm — and with
// the last step renamed, because it is now an ENDING rather than a state the
// parcel is passing through. "On its way" is right for a FedEx parcel at this
// point (Delivered follows), and wrong for a DPD one, where nothing follows
// and the customer is often reading it weeks after the cards landed.
const NO_DELIVERY_STEPS: TrackingStep[] = [
  ...FULL_STEPS.slice(0, 2),
  { key: 'on_its_way', label: 'Shipped' },
]

/**
 * The steps to draw for this parcel.
 *
 * `deliveryTracked === false` is the only thing that shortens the rail —
 * undefined/null means "not dispatched yet, so we don't know", and the honest
 * answer then is the full journey. An already-delivered parcel always gets the
 * long form: if the stamp exists, the step plainly exists too, whatever the
 * carrier allow-list happens to say today.
 */
export function stepsFor(
  deliveryTracked: boolean | null | undefined,
  stage: TrackingStage | null | undefined,
): TrackingStep[] {
  if (stage === 'delivered') return FULL_STEPS
  return deliveryTracked === false ? NO_DELIVERY_STEPS : FULL_STEPS
}

/**
 * Index of `stage` within `steps`. Falls back to the last step rather than -1
 * for a stage that isn't in the list, so a future stage can never render as
 * "before the beginning" — an unknown-but-later state is nearer done, not
 * nearer the start.
 */
export function stageIndexIn(steps: TrackingStep[], stage: TrackingStage): number {
  const i = steps.findIndex((s) => s.key === stage)
  if (i !== -1) return i
  const canonical = TRACKING_STAGES.indexOf(stage)
  const lastCanonical = TRACKING_STAGES.indexOf(steps[steps.length - 1].key)
  return canonical > lastCanonical ? steps.length - 1 : 0
}

/** Fraction of the rail filled, 0..1. Guards the single-step case. */
export function progressFraction(steps: TrackingStep[], index: number): number {
  if (steps.length <= 1) return index > 0 ? 1 : 0
  return Math.min(1, Math.max(0, index / (steps.length - 1)))
}

// ── What to CALL the stage, and what to say about it ────────────────────────
//
// STAGE_META holds the default for each stage. Exactly one of them varies, and
// it is the one this whole distinction exists for: `on_its_way` on a parcel
// whose carrier never confirms delivery is the END of the journey, not a
// waypoint. Rob, 31 Jul: "The current text is always present tense. But this
// really needs to be past tense when we reach the point where the reorder
// system kicks in" — that population is, by construction, people whose cards
// arrived weeks ago, and telling them the parcel is still travelling reads as
// though we have lost it.
//
// A stage that has reached `delivered` always uses the delivered copy, whatever
// the allow-list says — same rule stepsFor follows, and for the same reason:
// the stamp is evidence.

/** True when `on_its_way` is where this parcel's journey ENDS. */
function isTerminalDispatch(
  stage: TrackingStage,
  deliveryTracked: boolean | null | undefined,
): boolean {
  return stage === 'on_its_way' && deliveryTracked === false
}

export function stageLabel(
  stage: TrackingStage,
  deliveryTracked: boolean | null | undefined,
): string {
  return isTerminalDispatch(stage, deliveryTracked) ? 'Shipped' : STAGE_META[stage].label
}

/**
 * The sentence under the label. `shippedAt` is only ever used on the terminal
 * dispatch — a FedEx parcel genuinely IS on its way, and dating that would be
 * telling someone when their still-travelling parcel left, which is not the
 * question they have.
 */
export function stageLine(
  stage: TrackingStage,
  opts: { deliveryTracked?: boolean | null; shippedAt?: string | null } = {},
): string {
  if (!isTerminalDispatch(stage, opts.deliveryTracked)) return STAGE_META[stage].line
  const when = formatDispatchDate(opts.shippedAt)
  // No date recorded — still past tense, just without the detail we cannot
  // back up. Never falls back to a nearby timestamp that means something else.
  return when ? `Your cards were shipped on ${when}.` : 'Your cards have been sent.'
}

/**
 * "24 June 2026" — the same long form the approved card's "Signed off" line
 * uses directly above it, so one card doesn't carry two date formats.
 * Returns null for a missing or unparseable stamp, which drops the date rather
 * than printing "Invalid Date" at a customer.
 */
export function formatDispatchDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
