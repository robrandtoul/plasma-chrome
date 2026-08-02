// Numbered markers over a proof image.
//
// ⚠ THE ONE PLACE THIS MAY BE USED on a customer-facing surface is the zoom /
// detail view, where the customer has deliberately opened a card to inspect it.
// The overview must stay unmarked — it is the surface that sells the card, and
// the known funnel leak is "opened, never decided". See
// docs/proof-annotation-proposal.md §4.1.
//
// Positioning: markers are percentage-positioned children, so they must live
// inside the element that carries the image's own transform (or share its box).
// The stored coordinate anchors the SUBJECT; markerPosition() offsets the dot
// slightly so it does not cover the detail it points at.

import { markerPosition } from '../lib/proofAnnotations'

export interface MarkerPoint {
  id: string
  x: number
  y: number
  /** Optional label; defaults to the 1-based index. */
  label?: string
}

interface Props {
  points: MarkerPoint[]
  /** Which marker is currently emphasised, if any. */
  activeId?: string | null
  onSelect?: (id: string) => void
  /**
   * Counter-scale so markers keep a constant on-screen size while the image is
   * zoomed. Pass the live zoom factor from the viewer; defaults to 1.
   */
  scale?: number
  /** Rendered smaller where space is tight (thumbnail-sized previews). */
  compact?: boolean
}

export function ProofAnnotationMarkers({
  points,
  activeId = null,
  onSelect,
  scale = 1,
  compact = false,
}: Props) {
  if (points.length === 0) return null

  const size = compact ? 18 : 22
  const inverse = scale > 0 ? 1 / scale : 1

  return (
    <>
      {points.map((p, i) => {
        const pos = markerPosition(p.x, p.y)
        const isActive = activeId === p.id
        const label = p.label ?? String(i + 1)
        const interactive = typeof onSelect === 'function'

        const style: React.CSSProperties = {
          left: pos.left,
          top: pos.top,
          width: size,
          height: size,
          // translate(-50%,-50%) centres the dot on its (offset) point; the
          // counter-scale keeps it legible when the image is zoomed in.
          transform: `translate(-50%, -50%) scale(${inverse})`,
          transformOrigin: 'center center',
        }

        const className = [
          'absolute grid place-items-center rounded-full border-2 border-white',
          'text-[11px] font-medium leading-none tabular-nums',
          'shadow-[0_1px_3px_rgba(22,19,17,0.35)]',
          isActive ? 'bg-ink text-white' : 'bg-brand text-white',
          interactive ? 'cursor-pointer' : 'pointer-events-none',
        ].join(' ')

        if (!interactive) {
          return (
            <span key={p.id} aria-hidden="true" className={className} style={style}>
              {label}
            </span>
          )
        }

        return (
          <button
            key={p.id}
            type="button"
            aria-label={`Note ${label}`}
            aria-pressed={isActive}
            onClick={(e) => {
              // The image behind owns pan/zoom gestures and the backdrop closes
              // the viewer on self-click — neither should fire from a marker.
              e.stopPropagation()
              onSelect(p.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`${className} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600`}
            style={style}
          >
            {label}
          </button>
        )
      })}
    </>
  )
}
