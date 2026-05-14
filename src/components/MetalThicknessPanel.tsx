// Customer-facing panel that explains the three metal card thickness
// options (300μm, 500μm, 800μm). Appears on the customer proof page
// whenever the proof is for a metal material (material_code starts
// with 'metal_'), analogous to the letterpress LayeredConstructionPanel.
//
// Content is static — the three thickness options are fixed for all
// metal proofs. The panel is informational only; it does not interact
// with the proof's version data.
//
// Visual: an SVG showing three card-edge profiles side by side at
// proportional heights (aligned at the base), so the thickness
// difference is immediately legible. Below the SVG, a description
// list gives each option a short descriptor and a one-line context
// note to help the customer choose.

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

const OPTIONS: ThicknessOption[] = [
  {
    microns: 300,
    label: '300μm',
    name: 'Slim',
    description: 'The same thickness as a standard paper business card — solid metal throughout.',
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
    description: 'Close to the thickness of a bank card — the option that commands attention the moment it is handed over.',
  },
]

// SVG layout constants
const BAR_W = 44
const BAR_GAP = 20
const MAX_BAR_H = 52   // height in px for the 800μm bar
const LABEL_H = 18     // px below bar zone for the μm label
const SVG_H = MAX_BAR_H + LABEL_H + 6  // 6px between bar bottom and label
const SVG_W = OPTIONS.length * BAR_W + (OPTIONS.length - 1) * BAR_GAP

// Warm metallic mid-grey, distinct from the page ink so bars read as
// a material swatch rather than typographic content.
const BAR_FILL = '#9a9490'
const BAR_STROKE = 'rgba(26,22,18,0.15)'

export function MetalThicknessPanel() {
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

        {/* Card-edge profiles — proportional height bars, base-aligned */}
        <div>
          <svg
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            role="img"
            aria-label="Three card edge profiles at proportional heights: 300μm slim, 500μm mid-weight, 800μm substantial"
            style={{ display: 'block' }}
          >
            {OPTIONS.map((opt, i) => {
              const barH = Math.round((opt.microns / 800) * MAX_BAR_H)
              const barX = i * (BAR_W + BAR_GAP)
              // Bars align at their base: y = (MAX_BAR_H - barH)
              const barY = MAX_BAR_H - barH
              const labelY = MAX_BAR_H + 6 + LABEL_H / 2

              return (
                <g key={opt.microns}>
                  <rect
                    x={barX + 0.5}
                    y={barY + 0.5}
                    width={BAR_W - 1}
                    height={barH - 1}
                    fill={BAR_FILL}
                    stroke={BAR_STROKE}
                    strokeWidth={1}
                    rx={1}
                  />
                  <text
                    x={barX + BAR_W / 2}
                    y={labelY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{
                      fontFamily: "'Space Mono', 'Courier New', monospace",
                      fontSize: 9,
                      fontWeight: 500,
                      letterSpacing: '0.04em',
                      fill: `rgba(26,22,18,0.55)`,
                    }}
                  >
                    {opt.label}
                  </text>
                </g>
              )
            })}
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
            Card edge, side view
          </p>
        </div>

        {/* Descriptor key */}
        <dl className="grid gap-4 self-center">
          {OPTIONS.map((opt) => (
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
