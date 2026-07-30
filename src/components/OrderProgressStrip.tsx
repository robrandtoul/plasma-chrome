import {
  progressFraction,
  stageIndexIn,
  stepsFor,
  type TrackingStage,
} from '../lib/orderTracking'

// The compact order-progress strip that sits inside the approved card in the
// proof page's left rail.
//
// Deliberately NOT the pay page's rail. That one has a whole column to itself
// and can afford a labelled node per step; this lives in a 360px sticky rail
// under a card that already carries a medallion, a heading and a date. So the
// nodes stay unlabelled and the current stage is named once, in full, above
// them — which is the thing a customer actually reads. The shared logic
// (which steps exist, which one we're on) comes from lib/orderTracking so the
// two can't disagree about the journey while disagreeing about the layout.
//
// Colour rides --c-in-stock so it follows the approved signal rather than
// being frozen to a hex; on the customer page that token is rescoped by
// .customer-accent (design-tokens.css).

export interface OrderProgressStripProps {
  stage: TrackingStage
  /** null/undefined = not dispatched, so the full journey is drawn. */
  deliveryTracked: boolean | null
}

export default function OrderProgressStrip({ stage, deliveryTracked }: OrderProgressStripProps) {
  const steps = stepsFor(deliveryTracked, stage)
  const index = stageIndexIn(steps, stage)
  const fraction = progressFraction(steps, index)

  return (
    <div
      // The rail is decoration for a fact stated in words directly above it;
      // a screen reader gets "Step 3 of 4" instead of four unlabelled dots.
      role="group"
      aria-label={`Step ${index + 1} of ${steps.length}`}
    >
      <div className="relative h-[9px]" aria-hidden="true">
        {/* Track and fill are inset by half a node so the line starts and ends
            at the node centres rather than poking out past them. */}
        <div className="absolute left-[4px] right-[4px] top-[3.5px] h-[2px] rounded-full bg-line" />
        <div
          className="absolute left-[4px] top-[3.5px] h-[2px] rounded-full"
          style={{
            width: `calc((100% - 8px) * ${fraction})`,
            background: 'var(--c-in-stock)',
          }}
        />
        <ol className="relative flex h-[9px] justify-between">
          {steps.map((s, i) => {
            const reached = i <= index
            return (
              <li
                key={s.key}
                className="h-[9px] w-[9px] rounded-full"
                style={{
                  background: reached ? 'var(--c-in-stock)' : 'var(--c-surface)',
                  boxShadow: reached
                    ? undefined
                    : 'inset 0 0 0 1.5px color-mix(in srgb, var(--c-in-stock) 30%, transparent)',
                }}
              />
            )
          })}
        </ol>
      </div>
      <p className="mt-2 text-[12px] text-ink-mute">
        Step {index + 1} of {steps.length}
      </p>
    </div>
  )
}
