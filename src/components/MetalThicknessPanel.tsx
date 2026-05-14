// Customer-facing panel that explains the metal card thickness options.
// Appears on the customer proof page whenever the proof is for a metal
// material (material_code starts with 'metal_').
//
// Standard metal cards offer three thicknesses: 300μm, 500μm, 800μm.
// Mini Steel offers a different set: 200μm, 300μm, 500μm.
//
// The panel receives the material_code as a prop and picks the correct
// option set. Content is static and informational only.

import {
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  PAPER_BORDER,
} from '../lib/theme'

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
    <section
      aria-label="Metal thickness options"
      className="rounded-2xl"
      style={{
        background: '#ffffff',
        border: `0.5px solid ${PAPER_BORDER}`,
        padding: '24px 28px',
      }}
    >
      <dl className="grid gap-4">
        {options.map((opt) => (
          <div key={opt.label}>
            <div className="flex items-baseline gap-2">
              <dt
                className="font-paper-mono"
                style={{ fontSize: 12, fontWeight: 500, color: PAPER_INK }}
              >
                {opt.label}
              </dt>
              <span
                className="font-body"
                style={{ fontSize: 13, fontWeight: 500, color: PAPER_SECONDARY }}
              >
                {opt.name}
              </span>
            </div>
            <dd
              className="font-body mt-0.5"
              style={{ fontSize: 13, color: PAPER_TERTIARY, lineHeight: '1.5' }}
            >
              {opt.description}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
