// One selectable finish card on the pay page's open-spec chooser (000298/9),
// with a magnifying loupe over the finish photo — the whole point of the
// photos is surface texture (brushed vs mirror), so the customer can look
// close before they choose.
//
// Two inspection modes, one component:
//   * Desktop (hover-capable pointers): a circular loupe follows the cursor
//     over the image at LOUPE_ZOOM magnification. Pure CSS background maths —
//     no dependencies. Clicking the card still selects the finish.
//   * Everywhere (and the only mode on touch): a corner 🔍 badge opens a
//     full-screen viewer — photo large, drag/scroll to pan, a zoom toggle,
//     and a "Choose this finish" button so inspecting flows into selecting.
//     A touch loupe was deliberately NOT built: touch-dragging on the image
//     would fight page scrolling on a payment page.
//
// Structure note: the select surface is one <button> and the zoom badge is a
// SIBLING absolutely positioned over the photo corner — never a button inside
// a button (invalid HTML, breaks keyboard semantics).

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ZoomIn, ZoomOut } from 'lucide-react'

const LOUPE_SIZE = 200 // px diameter of the hover loupe
const LOUPE_ZOOM = 5 // hover magnification — texture-inspection strength; how
// crisp it looks at this level depends on the resolution of the uploaded photo
const OVERLAY_ZOOM = 2.5 // full-screen "zoomed in" width multiplier

interface FinishChoiceCardProps {
  name: string
  /** "Included" or "+£39" — shown on the right of the name row. */
  priceLabel: string
  imageSrc: string | null
  imageAlt: string
  selected: boolean
  onChoose: () => void
}

export function FinishChoiceCard({ name, priceLabel, imageSrc, imageAlt, selected, onChoose }: FinishChoiceCardProps) {
  // Hover loupe state — only wired up on hover-capable fine pointers, so
  // touch devices never mount the handlers at all.
  const [canHover] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  )
  const [loupe, setLoupe] = useState<{ x: number; y: number; px: number; py: number } | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  return (
    <div
      className={[
        'relative rounded-xl border transition-colors',
        selected ? 'border-[var(--c-brand)] bg-canvas ring-1 ring-[var(--c-brand)]' : 'border-line bg-surface hover:bg-canvas',
      ].join(' ')}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onChoose}
        className="block w-full rounded-xl p-3 text-left"
      >
        {imageSrc && (
          <span
            className="relative mb-2 block overflow-hidden rounded-lg ring-1 ring-line"
            onMouseMove={
              canHover
                ? (e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    setLoupe({ x, y, px: (x / rect.width) * 100, py: (y / rect.height) * 100 })
                  }
                : undefined
            }
            onMouseLeave={canHover ? () => setLoupe(null) : undefined}
          >
            <img src={imageSrc} alt={imageAlt} className="block w-full bg-canvas" />
            {canHover && loupe && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute rounded-full border-2 border-white shadow-lg ring-1 ring-line"
                style={{
                  width: LOUPE_SIZE,
                  height: LOUPE_SIZE,
                  left: loupe.x - LOUPE_SIZE / 2,
                  top: loupe.y - LOUPE_SIZE / 2,
                  backgroundImage: `url(${imageSrc})`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: `${LOUPE_ZOOM * 100}% auto`,
                  backgroundPosition: `${loupe.px}% ${loupe.py}%`,
                }}
              />
            )}
          </span>
        )}
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-ink">{name}</span>
          <span className="shrink-0 text-[12px] text-ink-soft">{priceLabel}</span>
        </span>
      </button>

      {/* Corner zoom badge — sibling of the select button, floated over the
          photo. The only zoom affordance on touch devices. */}
      {imageSrc && (
        <button
          type="button"
          aria-label={`Look at the ${name} finish close up`}
          onClick={() => setViewerOpen(true)}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm transition-opacity hover:bg-black/70"
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>
      )}

      {imageSrc && viewerOpen && (
        <FinishViewer
          name={name}
          priceLabel={priceLabel}
          imageSrc={imageSrc}
          imageAlt={imageAlt}
          selected={selected}
          onChoose={() => {
            onChoose()
            setViewerOpen(false)
          }}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  )
}

// Full-screen viewer: pan by native scrolling (free on touch — no gesture
// code), toggle between fit-width and OVERLAY_ZOOM. Esc / backdrop / ✕ close.
function FinishViewer({ name, priceLabel, imageSrc, imageAlt, selected, onChoose, onClose }: {
  name: string
  priceLabel: string
  imageSrc: string
  imageAlt: string
  selected: boolean
  onChoose: () => void
  onClose: () => void
}) {
  const [zoomedIn, setZoomedIn] = useState(false)

  // Lock the page behind while open; Esc closes.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${name} finish close up`}
      className="fixed inset-0 z-[100] flex flex-col bg-black/85"
      onClick={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-white">
          {name} <span className="font-normal text-white/70">· {priceLabel}</span>
        </p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Pan/zoom area — native scroll panning, tap-to-toggle zoom on the image. */}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" onClick={(e) => e.stopPropagation()}>
        <img
          src={imageSrc}
          alt={imageAlt}
          onClick={() => setZoomedIn((z) => !z)}
          className={zoomedIn ? 'max-w-none cursor-zoom-out' : 'mx-auto w-full max-w-3xl cursor-zoom-in'}
          style={zoomedIn ? { width: `${OVERLAY_ZOOM * 100}%` } : undefined}
        />
      </div>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setZoomedIn((z) => !z)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-[13px] font-medium text-white hover:bg-white/25"
        >
          {zoomedIn ? <ZoomOut size={15} aria-hidden="true" /> : <ZoomIn size={15} aria-hidden="true" />}
          {zoomedIn ? 'Fit to screen' : 'Zoom in'}
        </button>
        <button
          type="button"
          onClick={onChoose}
          className="rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-opacity hover:opacity-90"
        >
          {selected ? `${name} selected ✓` : `Choose ${name}`}
        </button>
      </div>
    </div>,
    document.body,
  )
}
