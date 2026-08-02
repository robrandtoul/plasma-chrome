// "Point at it" — where the customer places pins on their change request.
//
// Deliberately NOT built into the zoom/detail viewer. That viewer owns
// pointerdown/move/up with touchAction:'none' and already consumes a clean tap
// as a double-tap-to-zoom candidate, so tap-to-place there means threading a
// new mode through a live gesture state machine and wrapping the image in a
// transform carrier that clampTranslate() reads through. Placing pins on a
// plain, non-zoomable image inside the panel avoids all of it, and puts the
// pins next to the note the customer is already writing.
//
// Phone-first by construction: 57% of change requests are submitted from a
// phone, so this is tap-to-drop plus drag-to-nudge, never freehand drawing. A
// pin needs to be NEAR the thing — the text carries the instruction.

import { useRef, useState } from 'react'
import type { GridImage } from './ImageGrid'
import {
  MAX_ANNOTATION_BODY,
  MAX_PINS_PER_REQUEST,
  markerPosition,
  pointToFraction,
  type DraftPin,
} from '../lib/proofAnnotations'

interface Props {
  images: GridImage[]
  pins: DraftPin[]
  setPins: (next: DraftPin[]) => void
  disabled?: boolean
}

let pinSeq = 0

export function ProofPinPlacer({ images, pins, setPins, disabled = false }: Props) {
  const usable = images.filter((img) => Boolean(img.signed_url))
  const [activeImageId, setActiveImageId] = useState<string | null>(usable[0]?.id ?? null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const draggingRef = useRef<string | null>(null)

  if (usable.length === 0) return null

  const active = usable.find((img) => img.id === activeImageId) ?? usable[0]
  const activePins = pins.filter((p) => p.imageId === active.id)
  const atCap = pins.length >= MAX_PINS_PER_REQUEST

  function place(clientX: number, clientY: number) {
    if (disabled || atCap || !imgRef.current) return
    const { x, y } = pointToFraction(imgRef.current, clientX, clientY)
    const localId = `pin-${++pinSeq}`
    setPins([
      ...pins,
      {
        localId,
        imageId: active.id,
        side: active.side ?? null,
        associatedName: active.associated_name ?? null,
        x,
        y,
        body: '',
      },
    ])
    // Open the note field straight away — a pin with no words is not a request.
    setEditingId(localId)
  }

  function move(localId: string, clientX: number, clientY: number) {
    if (!imgRef.current) return
    const { x, y } = pointToFraction(imgRef.current, clientX, clientY)
    setPins(pins.map((p) => (p.localId === localId ? { ...p, x, y } : p)))
  }

  function update(localId: string, body: string) {
    setPins(pins.map((p) => (p.localId === localId ? { ...p, body } : p)))
  }

  function remove(localId: string) {
    setPins(pins.filter((p) => p.localId !== localId))
    if (editingId === localId) setEditingId(null)
  }

  return (
    <div>
      {usable.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {usable.map((img) => {
            const count = pins.filter((p) => p.imageId === img.id).length
            const isActive = img.id === active.id
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => setActiveImageId(img.id)}
                className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                  isActive
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-surface text-ink-soft hover:border-ink-mute'
                }`}
              >
                {img.side === 'front' ? 'Front' : img.side === 'back' ? 'Back' : (img.label ?? 'Card')}
                {count > 0 && <span className="ml-1 tabular-nums">· {count}</span>}
              </button>
            )
          })}
        </div>
      )}

      <div className="relative select-none overflow-hidden rounded-[6px] border border-line bg-canvas">
        <img
          ref={imgRef}
          src={active.signed_url}
          alt="Tap to point at part of your card"
          draggable={false}
          onClick={(e) => place(e.clientX, e.clientY)}
          className={`block w-full object-contain ${disabled || atCap ? '' : 'cursor-crosshair'}`}
        />

        {activePins.map((p) => {
          const idx = pins.findIndex((q) => q.localId === p.localId)
          const pos = markerPosition(p.x, p.y)
          return (
            <button
              key={p.localId}
              type="button"
              aria-label={`Pin ${idx + 1}${p.body ? `: ${p.body}` : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setEditingId(p.localId === editingId ? null : p.localId)
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                draggingRef.current = p.localId
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (draggingRef.current === p.localId) move(p.localId, e.clientX, e.clientY)
              }}
              onPointerUp={(e) => {
                draggingRef.current = null
                e.currentTarget.releasePointerCapture(e.pointerId)
              }}
              className={`absolute grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-white text-[11px] font-medium leading-none tabular-nums text-white shadow-[0_1px_3px_rgba(22,19,17,0.35)] ${
                editingId === p.localId ? 'bg-ink' : 'bg-brand'
              }`}
              style={{
                left: pos.left,
                top: pos.top,
                transform: 'translate(-50%, -50%)',
                touchAction: 'none',
              }}
            >
              {idx + 1}
            </button>
          )
        })}
      </div>

      <p className="mt-1.5 text-[11.5px] text-ink-mute">
        {atCap
          ? `That's the most pins we can send at once (${MAX_PINS_PER_REQUEST}). Use the notes box for anything else.`
          : 'Tap the image to drop a pin, then drag it to adjust. Optional — the notes box on its own is fine.'}
      </p>

      {pins.length > 0 && (
        <ul className="mt-2.5 grid gap-2">
          {pins.map((p, i) => (
            <li
              key={p.localId}
              className="rounded-[6px] border border-line bg-canvas px-2.5 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 grid h-[18px] w-[18px] flex-none place-items-center rounded-full bg-brand text-[11px] leading-none tabular-nums text-white">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <textarea
                    value={p.body}
                    onChange={(e) => update(p.localId, e.target.value.slice(0, MAX_ANNOTATION_BODY))}
                    onFocus={() => setEditingId(p.localId)}
                    rows={2}
                    placeholder="What needs changing here?"
                    className="w-full resize-y rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => remove(p.localId)}
                  aria-label={`Remove pin ${i + 1}`}
                  className="mt-0.5 flex-none rounded-[6px] px-1.5 py-0.5 text-[12px] text-ink-mute hover:text-ink"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
