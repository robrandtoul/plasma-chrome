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
            <p className="mb-0.5 text-[14px] font-medium text-ink">
              {opt.name}
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
