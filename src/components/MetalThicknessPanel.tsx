// Customer-facing panel that explains the metal card thickness options.
// Appears on the customer proof page whenever the proof is for a metal
// material (material_code starts with 'metal_').
//
// Standard metal cards (all codes except metal_mini_steel) offer three
// thicknesses: 300μm, 500μm, 800μm.
// Mini Steel offers a different set: 200μm, 300μm, 500μm.
//
// The panel receives the material_code as a prop and picks the correct
// option set. Bar widths are proportional to thickness relative to the
// maximum in the active set, so the diagram scales correctly for both.

import {
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  PAPER_BORDER,
} from '../lib/theme'

interface ThicknessOption {
  microns: number
  label: string          // e.g. "300μm"
  name: string           // e.g. "Slim"
  description: string    // one-line customer-facing note
}

const STANDARD_OPTIONS: ThicknessOption[] = [
  {
    microns: 300,
    label: '300μm',
    name: 'Slim',
    description: 'The same thickness as a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
  },
  {
    microns: 500,
    label: '500μm',
    name: 'Mid-weight',
    description: 'Noticeably more substantial than card stock, with a satisfying presence in the hand.',
  },
  {
    microns: 800,
    label: '800μm',
    name: 'Substantial',
    description: 'The thickness of a bank card — the option that commands attention the moment it is handed over. Rigid and reassuringly weighty.',
  },
]

const MINI_STEEL_OPTIONS: ThicknessOption[] = [
  {
    microns: 200,
    label: '200μm',
    name: 'Slim',
    description: 'Slightly thinner than a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
  },
  {
    microns: 300,
    label: '300μm',
    name: 'Mid-weight',
    description: 'Noticeably more rigid than card stock, with a satisfying presence in the hand.',
  },
  {
    microns: 500,
    label: '500μm',
    name: 'Substantial',
    description: 'The thickest option — it commands attention the moment it is handed over. Rigid and reassuringly weighty.',
  },
]

// SVG layout — three vertical bars, all the same height, widths
// proportional to thickness relative to the maximum in the active set.
const BAR_H = 200          // px — fixed height for all three bars
const MAX_BAR_W = 27       // px — width of the thickest bar in each set
const BAR_GAP = 42         // px — gap between bars
const LABEL_PAD = 8        // px — gap between bar bottom and label
const LABEL_H = 18         // px — label zone height
const SVG_PAD_LEFT = 20    // px — left padding so the first label isn't clipped

// Warm metallic mid-grey, distinct from the page ink so bars read as
// a material swatch rather than typographic content.
const BAR_FILL = '#9a9490'
const BAR_STROKE = 'rgba(26,22,18,0.15)'

// Build the bar geometry for a given option set. Bar widths scale relative
// to the maximum micron value in the set so proportions are always correct.
function buildBars(options: ThicknessOption[]) {
  const maxMicrons = Math.max(...options.map((o) => o.microns))
  let cumX = SVG_PAD_LEFT
  return options.map((opt, i) => {
    const barW = Math.round((opt.microns / maxMicrons) * MAX_BAR_W)
    const barX = cumX
    cumX += barW + (i < options.length - 1 ? BAR_GAP : 0)
    return { ...opt, barW, barX, svgW: cumX }
  })
}

interface MetalThicknessPanelProps {
  materialCode: string | null | undefined
}

export function MetalThicknessPanel({ materialCode }: MetalThicknessPanelProps) {
  const options = materialCode === 'metal_mini_steel' ? MINI_STEEL_OPTIONS : STANDARD_OPTIONS
  const bars = buildBars(options)
  const svgW = bars[bars.length - 1].svgW
  const svgH = BAR_H + LABEL_PAD + LABEL_H

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
      <div className="grid gap-8 sm:grid-cols-[auto_1fr] sm:items-start">

        {/* Card-edge view — equal height, width proportional to thickness */}
        <div>
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            role="img"
            aria-label={`Card edge profiles with widths proportional to thickness: ${options.map((o) => `${o.label} ${o.name}`).join(', ')}`}
            style={{ display: 'block' }}
          >
            {bars.map((bar) => (
              <g key={bar.microns}>
                <rect
                  x={bar.barX + 0.5}
                  y={0.5}
                  width={bar.barW - 1}
                  height={BAR_H - 1}
                  fill={BAR_FILL}
                  stroke={BAR_STROKE}
                  strokeWidth={1}
                  rx={1}
                />
                <text
                  x={bar.barX + bar.barW / 2}
                  y={BAR_H + LABEL_PAD + LABEL_H / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{
                    fontFamily: "'Space Mono', 'Courier New', monospace",
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    fill: 'rgba(26,22,18,0.55)',
                  }}
                >
                  {bar.label}
                </text>
              </g>
            ))}
          </svg>
          <p
            className="mt-3 font-paper-mono uppercase"
            style={{
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '0.28em',
              color: PAPER_TERTIARY,
            }}
          >
            Card edge, side view<br />Not to scale
          </p>
        </div>

        {/* Descriptor key */}
        <dl className="grid gap-4 self-center">
          {options.map((opt) => (
            <div key={opt.microns}>
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

      </div>
    </section>
  )
}
