import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Square, ArrowUpRight, Pen, Undo2, Trash2 } from 'lucide-react'
import Modal from './Modal'
import { ButtonGhost, ButtonInk } from '../design'

// Lightweight in-app screenshot markup. Loads an image onto a canvas at its
// natural resolution and lets the user draw rectangles, arrows, and freehand
// pen strokes in a handful of colours, then flattens everything to a PNG.
//
// The source is always a same-origin blob/object URL (a pasted, dropped, or
// picked screenshot), so drawImage + toBlob never taints the canvas.
//
// Shapes are stored in NATURAL image pixels; the canvas is displayed scaled to
// fit, and pointer coordinates are converted back to natural pixels so the
// export matches what the user drew at any display size.

type Tool = 'pen' | 'rect' | 'arrow'
interface Point {
  x: number
  y: number
}
type Shape =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'rect'; color: string; width: number; start: Point; end: Point }
  | { kind: 'arrow'; color: string; width: number; start: Point; end: Point }

const COLOURS = [
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#111827', label: 'Black' },
]

const TOOLS: { value: Tool; label: string; Icon: typeof Pen }[] = [
  { value: 'rect', label: 'Box', Icon: Square },
  { value: 'arrow', label: 'Arrow', Icon: ArrowUpRight },
  { value: 'pen', label: 'Pen', Icon: Pen },
]

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const head = Math.max(size * 3.5, 10)
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7))
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (s.kind === 'pen') {
    if (s.points.length === 0) return
    ctx.beginPath()
    ctx.moveTo(s.points[0].x, s.points[0].y)
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.stroke()
  } else if (s.kind === 'rect') {
    const x = Math.min(s.start.x, s.end.x)
    const y = Math.min(s.start.y, s.end.y)
    ctx.strokeRect(x, y, Math.abs(s.end.x - s.start.x), Math.abs(s.end.y - s.start.y))
  } else {
    ctx.beginPath()
    ctx.moveTo(s.start.x, s.start.y)
    ctx.lineTo(s.end.x, s.end.y)
    ctx.stroke()
    drawArrowhead(ctx, s.start, s.end, s.width)
  }
}

interface ScreenshotAnnotatorProps {
  src: string
  onCancel: () => void
  onSave: (blob: Blob) => void
}

export default function ScreenshotAnnotator({ src, onCancel, onSave }: ScreenshotAnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>('rect')
  const [colour, setColour] = useState(COLOURS[0].value)
  const [shapes, setShapes] = useState<Shape[]>([])
  const [drawing, setDrawing] = useState<Shape | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Stroke width in natural pixels, scaled to the image so a box on a 4K
  // screenshot isn't a hairline. Set once the image dimensions are known.
  const strokeRef = useRef(4)

  // Load the source image once.
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      strokeRef.current = Math.max(3, Math.round(img.naturalWidth / 250))
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
      }
      setReady(true)
    }
    // Without this, an undecodable image (e.g. a pasted HEIC) would leave the
    // canvas blank and Save permanently disabled with no explanation.
    img.onerror = () => setError('Could not load this image — remove it and try another.')
    img.src = src
    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [src])

  // Redraw the whole scene whenever shapes / the in-progress shape change.
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !ready) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    for (const s of shapes) drawShape(ctx, s)
    if (drawing) drawShape(ctx, drawing)
  }, [shapes, drawing, ready])

  function toCanvasPoint(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!ready) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toCanvasPoint(e)
    const width = strokeRef.current
    if (tool === 'pen') setDrawing({ kind: 'pen', color: colour, width, points: [p] })
    else if (tool === 'rect') setDrawing({ kind: 'rect', color: colour, width, start: p, end: p })
    else setDrawing({ kind: 'arrow', color: colour, width, start: p, end: p })
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing) return
    const p = toCanvasPoint(e)
    setDrawing((cur) => {
      if (!cur) return cur
      if (cur.kind === 'pen') return { ...cur, points: [...cur.points, p] }
      return { ...cur, end: p }
    })
  }

  function handlePointerUp() {
    if (!drawing) return
    // Discard a zero-size click (no drag) so a stray tap doesn't add an
    // invisible shape that Undo then has to clear.
    const meaningful =
      drawing.kind === 'pen'
        ? drawing.points.length > 1
        : Math.hypot(drawing.end.x - drawing.start.x, drawing.end.y - drawing.start.y) > 4
    if (meaningful) setShapes((prev) => [...prev, drawing])
    setDrawing(null)
  }

  function handleSave() {
    const canvas = canvasRef.current
    if (!canvas) return
    setSaving(true)
    canvas.toBlob(
      (blob) => {
        setSaving(false)
        if (blob) onSave(blob)
        else setError('Could not save the markup. Please try again.')
      },
      'image/png',
    )
  }

  return (
    <Modal
      open
      onClose={onCancel}
      ariaLabel="Mark up screenshot"
      panelClassName="w-full max-w-4xl rounded-2xl bg-white p-4 shadow-xl"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-ink">Mark up screenshot</span>

          {/* Tools */}
          <div className="flex items-center gap-1 rounded-lg border border-line p-1">
            {TOOLS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTool(value)}
                aria-pressed={tool === value}
                title={label}
                className={[
                  'flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
                  tool === value ? 'bg-ink text-on-ink' : 'text-ink-soft hover:bg-canvas',
                ].join(' ')}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {/* Colours */}
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
            {COLOURS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={colour === c.value}
                aria-label={c.label}
                onClick={() => setColour(c.value)}
                className={[
                  'h-7 w-7 rounded-full border transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                  colour === c.value ? 'scale-110 border-ink' : 'border-line hover:scale-105',
                ].join(' ')}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <ButtonGhost
              size="sm"
              icon={Undo2}
              onClick={() => setShapes((prev) => prev.slice(0, -1))}
              disabled={shapes.length === 0}
            >
              Undo
            </ButtonGhost>
            <ButtonGhost
              size="sm"
              icon={Trash2}
              onClick={() => setShapes([])}
              disabled={shapes.length === 0}
            >
              Clear
            </ButtonGhost>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex max-h-[68vh] justify-center overflow-auto rounded-lg border border-line bg-canvas p-2">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDrawing(null)}
            className="h-auto max-w-full cursor-crosshair rounded shadow-sm"
            style={{ touchAction: 'none' }}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto text-[12px] text-out">
              {error}
            </p>
          )}
          <ButtonGhost onClick={onCancel}>Cancel</ButtonGhost>
          <ButtonInk onClick={handleSave} busy={saving} disabled={!ready}>
            Save markup
          </ButtonInk>
        </div>
      </div>
    </Modal>
  )
}
