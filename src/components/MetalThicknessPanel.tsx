// Customer-facing panel that explains the metal card thickness options.
// Appears on the customer proof page whenever the proof is for a metal
// material (material_code starts with 'metal_').
//
// Standard metal cards offer three thicknesses: 300μm, 500μm, 800μm.
// Mini Steel offers a different set: 200μm, 300μm, 500μm.
//
// The panel receives the material_code as a prop and picks the correct
// option set. Content is static and informational only.

interface ThicknessOption {
  label: string          // e.g. "300μm"
  name: string           // e.g. "Slim"
  description: string    // one-line customer-facing note
}

const STANDARD_OPTIONS: ThicknessOption[] = [
  {
    label: '300μm',
    name: 'Slim',
    description: 'The same thickness as a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
  },
  {
    label: '500μm',
    name: 'Mid-weight',
    description: 'Noticeably more substantial than card stock, with a satisfying presence in the hand.',
  },
  {
    label: '800μm',
    name: 'Substantial',
    description: 'The thickness of a bank card — the option that commands attention the moment it is handed over. Rigid and reassuringly weighty.',
  },
]

const MINI_STEEL_OPTIONS: ThicknessOption[] = [
  {
    label: '200μm',
    name: 'Slim',
    description: 'Slightly thinner than a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
  },
  {
    label: '300μm',
    name: 'Mid-weight',
    description: 'Noticeably more rigid than card stock, with a satisfying presence in the hand.',
  },
  {
    label: '500μm',
    name: 'Substantial',
    description: 'The thickest option — it commands attention the moment it is handed over. Rigid and reassuringly weighty.',
  },
]

interface MetalThicknessPanelProps {
  materialCode: string | null | undefined
}

export function MetalThicknessPanel({ materialCode }: MetalThicknessPanelProps) {
  const options = materialCode === 'metal_mini_steel' ? MINI_STEEL_OPTIONS : STANDARD_OPTIONS

  return (
    <dl className="grid gap-4">
      {options.map((opt) => (
        <div key={opt.label}>
          <div className="flex items-baseline gap-2">
            <dt className="font-mono text-[12px] font-medium text-ink">
              {opt.label}
            </dt>
            <span className="text-[13px] font-medium text-ink-soft">
              {opt.name}
            </span>
          </div>
          <dd className="mt-0.5 text-[13px] text-ink-mute leading-[1.5]">
            {opt.description}
          </dd>
        </div>
      ))}
    </dl>
  )
}
