// Customer-facing panel that explains the metal card thickness options.
// Appears on the customer proof page whenever the proof is for a metal
// material (material_code starts with 'metal_').
//
// The copy is admin-editable (migration 000199 → settings.metal_thickness_notes
// → public_settings() RPC → getPublicSettings()). The caller resolves the
// correct set for the material (standard vs Mini Steel) via
// thicknessSetForMaterial() and passes the rows in here; this component is
// pure presentation.
//
// Styling mirrors the "Material notes" key-features list: a coral mono
// accent (here the µm value) in a fixed first column, then the weight
// name as a bold heading with a muted one-line description beneath.
//
// A row may carry a `badge` (the same field the pay-page thickness chooser
// reads). On this page it is only ever set to "Your last order · March 2024"
// for a returning customer the Reorder desk brought back — the guide is the
// one surface that describes what a thickness FEELS like, which is exactly
// what someone re-ordering wants confirming. The chip borrows the chooser's
// clothes verbatim so the two pages agree on what a badge looks like.

import type { ThicknessOption } from '../lib/metalThicknessNotes'

interface MetalThicknessPanelProps {
  options: ThicknessOption[]
}

export function MetalThicknessPanel({ options }: MetalThicknessPanelProps) {
  return (
    <dl className="max-w-[62ch] space-y-4">
      {options.map((opt) => (
        <div key={opt.label} className="grid grid-cols-[62px_1fr] items-baseline gap-3">
          <dt
            className="num font-medium text-brand leading-none"
            style={{ fontSize: 18 }}
          >
            {opt.label}
          </dt>
          <dd className="m-0">
            <p className="mb-0.5 flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
              {opt.name}
              {opt.badge && (
                <span
                  data-previous-order="thickness-guide"
                  className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-[var(--c-brand-800)]"
                >
                  {opt.badge}
                </span>
              )}
            </p>
            <p className="text-[13px] leading-[1.55] text-ink-mute">
              {opt.description}
            </p>
          </dd>
        </div>
      ))}
    </dl>
  )
}
