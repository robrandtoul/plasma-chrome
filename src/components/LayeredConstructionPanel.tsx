// Customer-facing panel that visualises the three-layer Colorplan
// construction of an un-gilded letterpress card (migration 000135).
// Renders nothing unless every layer's name + hex is populated, so
// non-letterpress and gilded versions naturally drop out without
// the caller needing to add a guard.
//
// Visual layout: 240x90 SVG cross-section on the left (front, core,
// back rendered as three stacked rects in supplied hex), and a
// layer key on the right (eyebrow + three rows in front/core/back
// order, each with the layer label, swatch, and colour name).
//
// Reuses CoreColourSwatch for the layer-key swatches so swatch
// styling stays consistent with the designer/admin surfaces.

import { stripDefaultSuffix } from '../lib/labels'
import { CoreColourSwatch } from './CoreColourSwatch'

interface LayeredConstructionPanelProps {
  front_name: string | null | undefined
  front_hex: string | null | undefined
  core_name: string | null | undefined
  core_hex: string | null | undefined
  back_name: string | null | undefined
  back_hex: string | null | undefined
}

const SVG_W = 240
const SVG_H = 90
const STROKE = 'rgba(22,19,17,0.18)'

export function LayeredConstructionPanel({
  front_name,
  front_hex,
  core_name,
  core_hex,
  back_name,
  back_hex,
}: LayeredConstructionPanelProps) {
  if (!front_name || !front_hex) return null
  if (!core_name || !core_hex) return null
  if (!back_name || !back_hex) return null

  // Admin-only "(default)" / "(default black)" hints are stripped here
  // so the customer panel renders just the colour name. The admin
  // letterpress colours list keeps the suffix to help designers pick
  // the canonical defaults. See stripDefaultSuffix in lib/labels.ts.
  const layers: Array<{ label: string; name: string; hex: string }> = [
    { label: 'Front', name: stripDefaultSuffix(front_name), hex: front_hex },
    { label: 'Core', name: stripDefaultSuffix(core_name), hex: core_hex },
    { label: 'Back', name: stripDefaultSuffix(back_name), hex: back_hex },
  ]

  // Layer heights split evenly across the SVG (front, core, back).
  const layerH = SVG_H / 3

  return (
    <div className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-start">
      {/* Cross-section diagram */}
      <div>
        <svg
          width={SVG_W}
          height={SVG_H}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          role="img"
          aria-label={`Card edge cross-section: ${layers[0].name} front, ${layers[1].name} core, ${layers[2].name} back`}
          style={{ display: 'block' }}
        >
          {layers.map((layer, i) => (
            <rect
              key={layer.label}
              x={0.5}
              y={i * layerH + 0.5}
              width={SVG_W - 1}
              height={layerH - (i === layers.length - 1 ? 1 : 0)}
              fill={layer.hex}
            />
          ))}
          {/* Hairline outline + inter-layer rules. Drawn after the
              fills so they sit on top. */}
          <rect
            x={0.5}
            y={0.5}
            width={SVG_W - 1}
            height={SVG_H - 1}
            fill="none"
            stroke={STROKE}
            strokeWidth={1}
          />
          {[1, 2].map((i) => (
            <line
              key={`rule-${i}`}
              x1={0}
              y1={i * layerH}
              x2={SVG_W}
              y2={i * layerH}
              stroke={STROKE}
              strokeWidth={1}
            />
          ))}
        </svg>
        <p className="eyebrow mt-3" style={{ letterSpacing: '0.22em' }}>
          Card edge, side view
        </p>
      </div>

      {/* Layer key */}
      <div>
        <dl className="grid gap-2.5">
          {layers.map((layer) => (
            <div
              key={layer.label}
              className="grid grid-cols-[64px_auto_1fr] items-center gap-3"
            >
              <dt className="text-[13px] text-ink-soft">{layer.label}</dt>
              <CoreColourSwatch
                hex={layer.hex}
                size={18}
                ariaLabel={`${layer.name} swatch`}
              />
              <dd className="text-[14px] font-medium text-ink">{layer.name}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
