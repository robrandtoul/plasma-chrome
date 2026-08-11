// Bring an old order's proofs in from Dropbox.
//
// The designer pastes whatever identifies the folder, and gets back a contact
// sheet of the proof images with the price panel already taken off. They tick
// what belongs in this version and press Add.
//
// ⚠ THE CONTACT SHEET IS THE POINT, not a courtesy. The crop is decided by
// measuring the image, and it is right on every one of the 215 real proofs it
// was tested against — but the thing being removed carries PRICES, so a wrong
// answer reaches a customer as a stale quote on artwork they are being asked to
// approve. Two rules follow and neither is negotiable:
//
//   · An image the software was not confident about is NOT pre-ticked. A whole
//     price grid is obvious at a glance; a few pixels of one is not, so the
//     cases where it is least sure are exactly the ones that must be looked at
//     deliberately rather than swept in with the rest.
//   · Every crop can be compared with the original before it is accepted. What
//     was taken off is as important as what is left.
//
// It also never guesses what the artwork MEANS — no recipient names, no proof
// type. Those set what the customer is charged, and a folder does not say.

import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { ButtonCoral, ButtonGhost, Input } from '../design'
import {
  importOrderProofs,
  releaseCandidates,
  summariseImport,
  type ImportCandidate,
  type ImportResult,
} from '../lib/dropboxProofImport'

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the files the designer ticked. */
  onAdd: (files: File[]) => void
}

export function DropboxImportModal({ open, onClose, onAdd }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [comparing, setComparing] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  // Object URLs are revoked when a result is replaced or the modal closes.
  // Held in a ref as well as state so the cleanup effect can reach the
  // outgoing set without depending on it and re-running on every change.
  const liveRef = useRef<ImportCandidate[]>([])

  useEffect(() => {
    if (open) return
    // Closing: drop everything and let the URLs go.
    abortRef.current?.abort()
    releaseCandidates(liveRef.current)
    liveRef.current = []
    setResult(null)
    setTicked(new Set())
    setComparing(new Set())
    setError('')
    setInput('')
    setBusy(false)
  }, [open])

  useEffect(() => () => releaseCandidates(liveRef.current), [])

  async function find() {
    const trimmed = input.trim()
    if (!trimmed || busy) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    releaseCandidates(liveRef.current)
    liveRef.current = []
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const res = await importOrderProofs(trimmed, { signal: controller.signal })
      if (controller.signal.aborted) return
      liveRef.current = res.candidates
      setResult(res)
      setError(res.error ?? '')
      // Pre-tick only what came back clean. Anything the detector flagged, or
      // that failed to read, is left for the designer to choose deliberately.
      setTicked(
        new Set(res.candidates.filter((c) => c.file && !c.error && c.panel?.confidence !== 'unsure').map((c) => c.id)),
      )
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setError('Could not read that Dropbox folder.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCompare(id: string) {
    setComparing((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function add() {
    const files = (result?.candidates ?? []).filter((c) => c.file && ticked.has(c.id)).map((c) => c.file as File)
    if (files.length === 0) return
    onAdd(files)
    onClose()
  }

  const chosen = result?.candidates.filter((c) => c.file && ticked.has(c.id)).length ?? 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={busy}
      ariaLabelledBy="dropbox-import-heading"
      panelClassName="w-full max-w-5xl rounded-2xl bg-white p-6 shadow-xl max-h-[90dvh] overflow-y-auto"
    >
      <h2 id="dropbox-import-heading" className="text-lg font-semibold text-slate-900">
        Bring in artwork from an old order
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Paste the Dropbox folder — a link, the address from Dropbox, or just the folder name like{' '}
        <span className="whitespace-nowrap font-medium">Order 38294 - Norwood</span>.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void find()
            }
          }}
          placeholder="Order 38294 - Norwood"
          aria-label="Dropbox folder"
          className="flex-1"
          disabled={busy}
        />
        <ButtonCoral type="button" onClick={() => void find()} disabled={busy || !input.trim()}>
          {busy ? 'Looking…' : 'Find proofs'}
        </ButtonCoral>
      </div>

      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}

      {busy && (
        <p className="mt-4 text-sm text-slate-600">
          Reading the folder and taking the price panel off each proof…
        </p>
      )}

      {result && !busy && (
        <div className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-2">
            <p className="text-sm font-medium text-slate-900">{result.folderName || 'Folder'}</p>
            <p className="text-sm text-slate-600">{summariseImport(result)}</p>
          </div>
          {result.basis && <p className="mt-2 text-sm text-slate-600">{result.basis}</p>}

          {result.candidates.length === 0 && (
            <p className="mt-4 text-sm text-slate-600">No proof images in that folder.</p>
          )}

          <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {result.candidates.map((c) => {
              const showingOriginal = comparing.has(c.id)
              const url = showingOriginal ? c.originalUrl : c.previewUrl
              const selectable = Boolean(c.file)
              return (
                <li key={c.id} className="rounded-xl border border-slate-200 p-2">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={ticked.has(c.id)}
                      onChange={() => toggle(c.id)}
                      disabled={!selectable}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800" title={c.name}>
                      {c.name}
                    </span>
                  </label>

                  <div className="mt-2 aspect-[4/3] overflow-hidden rounded-lg bg-slate-100">
                    {url ? (
                      <img src={url} alt={c.name} className="h-full w-full object-contain" />
                    ) : (
                      <div className="flex h-full items-center justify-center px-2 text-center text-xs text-slate-500">
                        Could not read this image
                      </div>
                    )}
                  </div>

                  {c.panel?.hasPanel && (
                    <button
                      type="button"
                      onClick={() => toggleCompare(c.id)}
                      className="mt-2 text-xs font-medium text-slate-700 underline underline-offset-2"
                    >
                      {showingOriginal ? 'Show the crop' : 'Show what was removed'}
                    </button>
                  )}

                  {/* The flag has to be readable, not decorative: this is the
                      one place a designer can catch a sliver of price grid. */}
                  {c.panel?.hasPanel && c.panel.confidence === 'unsure' && (
                    <p className="mt-1 text-xs text-amber-700">Not sure about this crop — please check it.</p>
                  )}
                  {c.error && <p className="mt-1 text-xs text-rose-700">{c.error}</p>}
                  {c.panel?.hasPanel === false && !c.error && (
                    <p className="mt-1 text-xs text-slate-500">No price panel — added as-is.</p>
                  )}
                </li>
              )
            })}
          </ul>

          {result.skipped.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-slate-600">
                {result.skipped.length} other file{result.skipped.length === 1 ? '' : 's'} in this folder
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {result.skipped.map((s, i) => (
                  <li key={`${s.name}-${i}`}>
                    <span className="font-medium">{s.name}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        <ButtonGhost type="button" onClick={onClose} disabled={busy}>
          Cancel
        </ButtonGhost>
        <ButtonCoral type="button" onClick={add} disabled={busy || chosen === 0}>
          {chosen === 0 ? 'Add images' : `Add ${chosen} image${chosen === 1 ? '' : 's'}`}
        </ButtonCoral>
      </div>
    </Modal>
  )
}
