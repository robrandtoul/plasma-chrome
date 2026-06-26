import { useEffect, useId, useRef, useState, type ClipboardEvent } from 'react'
import { ImagePlus, Pencil, X } from 'lucide-react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { Field, Input, Textarea, ButtonInk, ButtonGhost } from '../design'
import {
  FEEDBACK_TYPES,
  FEEDBACK_PRIORITIES,
  FEEDBACK_BUCKET,
  type FeedbackItem,
  type FeedbackType,
  type FeedbackPriority,
} from '../lib/feedback'
import ScreenshotAnnotator from './ScreenshotAnnotator'

const MAX_ATTACHMENTS = 6
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB — matches the bucket cap

// A staged screenshot, before upload. blob is the current bytes (swapped for
// the marked-up version when the annotator saves); url is an object URL for
// the thumbnail, revoked when the attachment is removed/replaced.
interface Attachment {
  id: string
  blob: Blob
  url: string
}

function extFor(type: string): string {
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  return 'png'
}

interface FeedbackModalProps {
  onClose: () => void
  onCreated: (item: FeedbackItem) => void
}

export default function FeedbackModal({ onClose, onCreated }: FeedbackModalProps) {
  const titleId = useId()
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const fileRef = useRef<HTMLInputElement>(null)

  const [type, setType] = useState<FeedbackType>('idea')
  const [priority, setPriority] = useState<FeedbackPriority>('medium')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [area, setArea] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [annotateId, setAnnotateId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Revoke any outstanding object URLs on unmount.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.url)
    }
  }, [])

  function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    // Do the filtering + object-URL creation OUTSIDE the state updater so the
    // updater stays pure (Strict Mode double-invokes it). Size-filter BEFORE
    // applying the cap budget so an oversized file can't consume a slot that a
    // valid screenshot needs.
    const sized = images.filter((f) => f.size <= MAX_BYTES)
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length)
    const additions = sized.slice(0, room).map((f) => ({
      id: crypto.randomUUID(),
      blob: f as Blob,
      url: URL.createObjectURL(f),
    }))

    // One message wins; prefer the cap warning over the size warning.
    let message: string | null = null
    if (sized.length < images.length) message = 'Each screenshot must be 10 MB or smaller.'
    if (sized.length > room) message = `You can attach up to ${MAX_ATTACHMENTS} screenshots.`
    setError(message)

    if (additions.length > 0) setAttachments((prev) => [...prev, ...additions])
  }

  const { isZoneDragOver, zoneProps } = useImageFileDrop({ onFiles: addFiles })

  function handlePaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id)
      if (found) URL.revokeObjectURL(found.url)
      return prev.filter((a) => a.id !== id)
    })
  }

  // The annotator returns a flattened PNG; swap it in for the original bytes.
  function applyMarkup(id: string, blob: Blob) {
    setAttachments((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a
        URL.revokeObjectURL(a.url)
        return { ...a, blob, url: URL.createObjectURL(blob) }
      }),
    )
    setAnnotateId(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      setError('Please add a short title.')
      return
    }
    if (!userId) {
      setError('You appear to be signed out — please reload and try again.')
      return
    }

    setSubmitting(true)

    // The submitter's name/initials/colour are stamped server-side from the
    // caller's own profile by the feedback_items_set_author trigger, so the
    // client doesn't supply them (and can't falsify them).

    // Upload the screenshots first; collect their storage keys.
    const uploaded: string[] = []
    for (const a of attachments) {
      const path = `${userId}/${crypto.randomUUID()}.${extFor(a.blob.type)}`
      const { error: upErr } = await supabase.storage
        .from(FEEDBACK_BUCKET)
        .upload(path, a.blob, { contentType: a.blob.type || 'image/png', upsert: false })
      if (upErr) {
        // Roll back anything already uploaded so we don't leave orphans.
        if (uploaded.length > 0) await supabase.storage.from(FEEDBACK_BUCKET).remove(uploaded)
        setSubmitting(false)
        setError(upErr.message || 'Could not upload a screenshot. Please try again.')
        return
      }
      uploaded.push(path)
    }

    const { data: row, error: insErr } = await supabase
      .from('feedback_items')
      .insert({
        created_by: userId,
        type,
        priority,
        title: cleanTitle,
        body: body.trim() || null,
        area: area.trim() || null,
        attachment_paths: uploaded,
      })
      .select('*')
      .single()

    if (insErr || !row) {
      if (uploaded.length > 0) await supabase.storage.from(FEEDBACK_BUCKET).remove(uploaded)
      setSubmitting(false)
      setError(insErr?.message || 'Could not save your feedback. Please try again.')
      return
    }

    void logAudit({
      action: 'feedback.created',
      targetType: 'feedback',
      targetId: (row as FeedbackItem).id,
      targetLabel: cleanTitle,
      metadata: { type, attachments: uploaded.length },
    })

    setSubmitting(false)
    onCreated(row as FeedbackItem)
  }

  const annotating = attachments.find((a) => a.id === annotateId) ?? null

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={submitting}
      ariaLabelledBy={titleId}
      panelClassName="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5" onPaste={handlePaste}>
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-ink">
            Share feedback
          </h3>
          <p className="mt-1 text-[13px] text-ink-mute">
            Report a bug or suggest an idea. Paste a screenshot (⌘V), drop one in, or pick a file —
            and mark it up if it helps.
          </p>
        </div>

        {/* Type */}
        <div>
          <span className="eyebrow mb-1.5 block">Type</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Feedback type">
            {FEEDBACK_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={type === t.value}
                onClick={() => setType(t.value)}
                className={[
                  'h-9 flex-1 rounded-[8px] border text-[13px] font-medium transition-colors',
                  type === t.value
                    ? 'border-brand bg-brand-50 text-ink'
                    : 'border-line bg-surface text-ink-mute hover:bg-canvas',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Priority — a suggestion; an admin can change it later. */}
        <div>
          <span className="eyebrow mb-1.5 block">Priority</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Priority">
            {FEEDBACK_PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={priority === p.value}
                onClick={() => setPriority(p.value)}
                className={[
                  'h-9 flex-1 rounded-[8px] border text-[13px] font-medium transition-colors',
                  priority === p.value
                    ? 'border-brand bg-brand-50 text-ink'
                    : 'border-line bg-surface text-ink-mute hover:bg-canvas',
                ].join(' ')}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <Field label="Title" htmlFor={`${titleId}-title`}>
          <Input
            id={`${titleId}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Quantity picker resets when I switch material"
            maxLength={140}
          />
        </Field>

        <Field label="Details" hint="What happened, or what you'd like — as much or as little as you want." htmlFor={`${titleId}-body`}>
          <Textarea
            id={`${titleId}-body`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Steps to reproduce a bug, or how an idea would help…"
          />
        </Field>

        <Field label="Page or area (optional)" htmlFor={`${titleId}-area`}>
          <Input
            id={`${titleId}-area`}
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder="e.g. New version form, Orders page"
            maxLength={80}
          />
        </Field>

        {/* Screenshots */}
        <div>
          <span className="eyebrow mb-1.5 block">Screenshots (optional)</span>
          <div
            {...zoneProps}
            className={[
              'rounded-[10px] border border-dashed p-3 transition-colors',
              isZoneDragOver ? 'border-brand bg-brand-50' : 'border-line bg-canvas',
            ].join(' ')}
          >
            {attachments.length > 0 && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                {attachments.map((a, i) => (
                  <div key={a.id} className="group relative overflow-hidden rounded-lg border border-line bg-surface">
                    <img src={a.url} alt={`Screenshot ${i + 1}`} className="h-20 w-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1 bg-black/55 px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() => setAnnotateId(a.id)}
                        aria-label={`Mark up screenshot ${i + 1}`}
                        className="flex items-center gap-1 text-[11px] font-medium text-white hover:underline"
                      >
                        <Pencil size={12} aria-hidden="true" /> Mark up
                      </button>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        aria-label={`Remove screenshot ${i + 1}`}
                        className="text-white/90 hover:text-white"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] text-ink-mute">
                {attachments.length > 0
                  ? `${attachments.length} of ${MAX_ATTACHMENTS} added`
                  : 'Paste, drop, or add an image.'}
              </p>
              <ButtonGhost
                size="sm"
                icon={ImagePlus}
                onClick={() => fileRef.current?.click()}
                disabled={attachments.length >= MAX_ATTACHMENTS}
              >
                Add image
              </ButtonGhost>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ButtonGhost onClick={onClose} disabled={submitting}>
            Cancel
          </ButtonGhost>
          <ButtonInk type="submit" busy={submitting}>
            Send feedback
          </ButtonInk>
        </div>
      </form>

      {annotating && (
        <ScreenshotAnnotator
          src={annotating.url}
          onCancel={() => setAnnotateId(null)}
          onSave={(blob) => applyMarkup(annotating.id, blob)}
        />
      )}
    </Modal>
  )
}
