// Designer-side annotation surface (migration 000347).
//
// Two jobs in one place, because they are the same conversation:
//   • write CALLOUTS the customer will read ("your logo sits smaller than your
//     file — that's the finest the engraving holds")
//   • work through the PINS a customer sent with a change request, ticking each
//     off as it is addressed
//
// Self-contained on purpose: the designer proof page renders no proof imagery of
// its own, so rather than thread an image pipeline through that 4,900-line page,
// this modal loads and signs what it needs — the same pattern VersionDetailModal
// already uses.
//
// A reminder about the customer end, since it is easy to undo from here: what
// the designer writes appears BESIDE the customer's card, not on it. Numbered
// markers on artwork exist only inside the zoom view. See
// docs/proof-annotation-proposal.md §4.1.

import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'
import { ButtonGhost, ButtonInk } from '../design'
import { supabase } from '../lib/supabase'
import {
  MAX_ANNOTATION_BODY,
  createCallout,
  deleteAnnotation,
  fetchAnnotations,
  markerPosition,
  pointToFraction,
  setAnnotationResolved,
  updateCalloutBody,
  type ProofAnnotation,
} from '../lib/proofAnnotations'

/**
 * A note the designer has placed but not yet written.
 *
 * Clicking the artwork used to insert the row immediately with an empty body,
 * which the schema rightly refuses (btrim(body) <> ''). Holding it locally until
 * it has words means no stored note is ever blank, and it matches how the
 * customer-side placer already behaves.
 */
interface DraftNote {
  localId: string
  imageId: string
  side: 'front' | 'back' | null
  associatedName: string | null
  x: number
  y: number
  body: string
}

let draftSeq = 0

interface EditorImage {
  id: string
  image_path: string
  side: 'front' | 'back' | null
  associated_name: string | null
  signed_url: string
}

interface Props {
  open: boolean
  onClose: () => void
  versionId: string
  versionNumber: number
  userId: string
  /** Called after any change, so the parent can refresh a count badge. */
  onChanged?: () => void
  /**
   * Reports how many notes the customer would see. Lets a parent label its own
   * button without repeating the query — the preview gate uses this so its chip
   * reads "Notes for the customer · 2" the moment one is written.
   */
  onCountChange?: (count: number) => void
}

export function ProofAnnotationEditor({
  open,
  onClose,
  versionId,
  versionNumber,
  userId,
  onChanged,
  onCountChange,
}: Props) {
  const [images, setImages] = useState<EditorImage[]>([])
  const [annotations, setAnnotations] = useState<ProofAnnotation[]>([])
  const [drafts, setDrafts] = useState<DraftNote[]>([])
  const [activeImageId, setActiveImageId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      setAnnotations(await fetchAnnotations(versionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notes.')
    }
  }, [versionId])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const { data, error: imgErr } = await supabase
          .from('proof_version_images')
          .select('id, image_path, side, associated_name')
          .eq('proof_version_id', versionId)
          .eq('is_qr_code', false)
          .order('sort_order')
        if (imgErr) throw imgErr

        const rows = data ?? []
        let signed: EditorImage[] = []
        if (rows.length > 0) {
          const { data: urls } = await supabase.storage
            .from('proof-images')
            .createSignedUrls(
              rows.map((r) => r.image_path as string),
              3600,
            )
          signed = rows
            .map((r, i) => ({
              id: r.id as string,
              image_path: r.image_path as string,
              side: (r.side as 'front' | 'back' | null) ?? null,
              associated_name: (r.associated_name as string | null) ?? null,
              signed_url: urls?.[i]?.signedUrl ?? '',
            }))
            .filter((r) => r.signed_url !== '')
        }

        if (cancelled) return
        setImages(signed)
        setActiveImageId((prev) => prev ?? signed[0]?.id ?? null)
        setAnnotations(await fetchAnnotations(versionId))
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load this version.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, versionId])

  const active = images.find((i) => i.id === activeImageId) ?? images[0] ?? null
  const callouts = annotations.filter((a) => a.author_kind === 'designer')
  const pins = annotations.filter((a) => a.author_kind === 'customer')
  // Saved notes and unsaved drafts share one numbering, so the dot on the card
  // always matches the row beneath it.
  const items: { key: string; imageId: string | null; x: number; y: number; draft?: DraftNote; saved?: ProofAnnotation }[] = [
    ...callouts.map((c) => ({
      key: c.id,
      imageId: c.proof_version_image_id,
      x: Number(c.x),
      y: Number(c.y),
      saved: c,
    })),
    ...drafts.map((d) => ({
      key: d.localId,
      imageId: d.imageId,
      x: d.x,
      y: d.y,
      draft: d,
    })),
  ]
  const activeItems = active ? items.filter((i) => i.imageId === active.id) : []

  function place(clientX: number, clientY: number) {
    if (!active || !imgEl) return
    const { x, y } = pointToFraction(imgEl, clientX, clientY)
    setError(null)
    setDrafts((prev) => [
      ...prev,
      {
        localId: `d-${++draftSeq}`,
        imageId: active.id,
        side: active.side,
        associatedName: active.associated_name,
        x,
        y,
        body: '',
      },
    ])
  }

  function updateDraft(localId: string, body: string) {
    setDrafts((prev) => prev.map((d) => (d.localId === localId ? { ...d, body } : d)))
  }

  /**
   * Persist a draft once it has words. A draft with nothing typed simply waits —
   * it is not an error, and the dot stays on the artwork so the designer can see
   * where they were going. If the write fails the draft is KEPT, so nothing they
   * typed is lost to a failed request.
   */
  async function commitDraft(localId: string) {
    const draft = drafts.find((d) => d.localId === localId)
    if (!draft) return
    const body = draft.body.trim()
    if (!body) return
    setBusyId(localId)
    try {
      const row = await createCallout({
        versionId,
        imageId: draft.imageId,
        side: draft.side,
        associatedName: draft.associatedName,
        x: draft.x,
        y: draft.y,
        body,
        userId,
      })
      setAnnotations((prev) => [...prev, row])
      setDrafts((prev) => prev.filter((d) => d.localId !== localId))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that note.')
    } finally {
      setBusyId(null)
    }
  }

  function discardDraft(localId: string) {
    setDrafts((prev) => prev.filter((d) => d.localId !== localId))
  }

  async function saveBody(id: string, body: string) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, body } : a)))
    try {
      await updateCalloutBody(id, body)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that note.')
      void reload()
    }
  }

  async function remove(id: string) {
    setBusyId(id)
    try {
      await deleteAnnotation(id)
      setAnnotations((prev) => prev.filter((a) => a.id !== id))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that note.')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleResolved(a: ProofAnnotation) {
    const next = a.resolved_at == null
    setAnnotations((prev) =>
      prev.map((row) =>
        row.id === a.id
          ? { ...row, resolved_at: next ? new Date().toISOString() : null }
          : row,
      ),
    )
    try {
      await setAnnotationResolved(a.id, next, userId)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that item.')
      void reload()
    }
  }

  const resolvedCount = pins.filter((p) => p.resolved_at != null).length

  // Drafts deliberately don't count — the number should mean "what the customer
  // would see", and an unwritten pin is not yet a note.
  useEffect(() => {
    onCountChange?.(callouts.length)
  }, [callouts.length, onCountChange])

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={`Notes on version ${versionNumber}`}
      panelClassName="w-full max-w-3xl rounded-2xl bg-white p-0 shadow-xl overflow-hidden"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="text-[16px] font-medium text-ink">Notes on v{versionNumber}</h2>
        <ButtonGhost onClick={onClose}>Close</ButtonGhost>
      </div>

      <div className="max-h-[74vh] overflow-y-auto px-5 py-4">
        {error && (
          <p className="mb-3 rounded-[6px] border border-out bg-out-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        )}

        {loading && <p className="text-[13.5px] text-ink-mute">Loading…</p>}

        {!loading && images.length === 0 && (
          <p className="text-[13.5px] text-ink-mute">
            This version has no artwork to annotate yet.
          </p>
        )}

        {!loading && images.length > 0 && active && (
          <>
            {images.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {images.map((img) => {
                  const n = callouts.filter((c) => c.proof_version_image_id === img.id).length
                  const isActive = img.id === active.id
                  const face =
                    img.side === 'front' ? 'Front' : img.side === 'back' ? 'Back' : 'Card'
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
                      {img.associated_name ? `${img.associated_name} · ${face}` : face}
                      {n > 0 && <span className="ml-1 tabular-nums">· {n}</span>}
                    </button>
                  )
                })}
              </div>
            )}

            <div className="relative select-none overflow-hidden rounded-[8px] border border-line bg-canvas">
              <img
                ref={setImgEl}
                src={active.signed_url}
                alt="Click to add a note"
                draggable={false}
                onClick={(e) => void place(e.clientX, e.clientY)}
                className="block w-full cursor-crosshair object-contain"
              />
              {activeItems.map((item) => {
                const idx = items.findIndex((x) => x.key === item.key)
                const pos = markerPosition(item.x, item.y)
                const unsaved = item.draft != null
                return (
                  <span
                    key={item.key}
                    aria-hidden="true"
                    className={`pointer-events-none absolute grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-white text-[11px] font-medium leading-none tabular-nums shadow-[0_1px_3px_rgba(22,19,17,0.35)] ${
                      unsaved
                        ? 'bg-white text-brand-700 ring-2 ring-inset ring-[var(--c-brand)]'
                        : 'bg-brand text-white'
                    }`}
                    style={{ left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)' }}
                  >
                    {idx + 1}
                  </span>
                )
              })}
            </div>
            <p className="mt-1.5 text-[11.5px] text-ink-mute">
              Click the artwork to add a note. The customer sees these beside their card, never
              drawn on it — a marker only appears if they zoom in.
            </p>

            {items.length > 0 && (
              <ul className="mt-3 grid gap-2">
                {items.map((item, i) => {
                  const draft = item.draft
                  const saved = item.saved
                  return (
                    <li
                      key={item.key}
                      className="rounded-[6px] border border-line bg-canvas px-2.5 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 grid h-[18px] w-[18px] flex-none place-items-center rounded-full text-[11px] leading-none tabular-nums ${
                            draft
                              ? 'bg-white text-brand-700 ring-2 ring-inset ring-[var(--c-brand)]'
                              : 'bg-brand text-white'
                          }`}
                        >
                          {i + 1}
                        </span>
                        {draft ? (
                          <textarea
                            autoFocus
                            value={draft.body}
                            rows={2}
                            maxLength={MAX_ANNOTATION_BODY}
                            placeholder="What should the customer know about this?"
                            onChange={(e) => updateDraft(draft.localId, e.target.value)}
                            onBlur={() => void commitDraft(draft.localId)}
                            className="min-w-0 flex-1 resize-y rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600"
                          />
                        ) : (
                          <textarea
                            defaultValue={saved!.body}
                            rows={2}
                            maxLength={MAX_ANNOTATION_BODY}
                            onBlur={(e) => {
                              const next = e.target.value.trim()
                              // A saved note cannot be emptied — the schema
                              // requires words, and "no note" is what Remove is
                              // for. Put the stored text back so the field never
                              // shows something different from what is saved.
                              if (!next) {
                                e.target.value = saved!.body
                                return
                              }
                              if (next !== saved!.body) void saveBody(saved!.id, next)
                            }}
                            className="min-w-0 flex-1 resize-y rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600"
                          />
                        )}
                        <button
                          type="button"
                          disabled={busyId === item.key}
                          onClick={() =>
                            draft ? discardDraft(draft.localId) : void remove(saved!.id)
                          }
                          className="mt-0.5 flex-none rounded-[6px] px-1.5 py-0.5 text-[12px] text-ink-mute hover:text-ink disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                      {draft && (
                        <p className="mt-1 pl-[26px] text-[11.5px] text-ink-mute">
                          Type the note and click away to save it.
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {/* Customer pins — the tick-off half. Separate block because these are
            work to do, not copy to write. */}
        {pins.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h3 className="text-[14px] font-medium text-ink">What the customer pointed at</h3>
              <span className="font-mono text-[11.5px] tabular-nums text-ink-mute">
                {resolvedCount} of {pins.length} done
              </span>
            </div>
            <ul className="mt-2">
              {pins.map((p, i) => (
                <li
                  key={p.id}
                  className="flex items-start gap-2.5 border-b border-line-soft py-2.5 last:border-b-0"
                >
                  <input
                    type="checkbox"
                    id={`pin-${p.id}`}
                    checked={p.resolved_at != null}
                    onChange={() => void toggleResolved(p)}
                    className="mt-1 h-[15px] w-[15px] flex-none accent-[var(--c-in-stock)]"
                  />
                  <label
                    htmlFor={`pin-${p.id}`}
                    className={`cursor-pointer text-[13.5px] ${
                      p.resolved_at != null ? 'text-ink-mute line-through' : 'text-ink-soft'
                    }`}
                  >
                    <span className="font-medium">
                      {i + 1}
                      {p.side ? ` · ${p.side}` : ''}
                      {p.associated_name ? ` · ${p.associated_name}` : ''}
                    </span>{' '}
                    — {p.body}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <ButtonInk onClick={onClose}>Done</ButtonInk>
      </div>
    </Modal>
  )
}
