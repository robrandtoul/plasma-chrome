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

// Same journey, minus a destination we'd never be able to confirm.
const NO_DELIVERY_STEPS: TrackingStep[] = FULL_STEPS.slice(0, 3)

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
