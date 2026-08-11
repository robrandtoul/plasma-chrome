import { useState } from 'react'
import { Check, AlertTriangle } from 'lucide-react'
import {
  downloadApprovedArtworkZip,
  downloadApprovedFile,
  type ApprovedArtwork,
  type ApprovedArtworkFile,
  type ApprovedArtworkLoad,
} from '../lib/approvedArtwork'

// The one-line version of ApprovedArtworkPanel, for a COLLAPSED To-order card.
//
// The panel only exists inside the expanded prep form, so the two facts a
// designer wants while triaging the queue — what the approved files are called,
// and getting hold of them — were three clicks and a scroll away on every card.
// Downloading the artwork is also the FIRST step of prep (files → Dropbox order
// folder → paste the link back), so putting the download on the collapsed row
// takes the expand out of the loop entirely.
//
// Deliberately quiet rather than the panel's green-filled block: on a card whose
// call to action is the amber "Folder needed" / "Date needed" chips directly
// above, a second filled block competes with the thing that actually needs
// doing. This is reference, so it reads as reference.
//
// Never fetches. The Orders page loads every card's artwork in one batch
// (fetchApprovedArtworkBatch) and hands it down, so a queue of a dozen orders
// costs a fixed handful of requests instead of four per card.

export default function ApprovedArtworkStrip({
  load,
  projectName,
  customerName,
  materialDisplay,
  onShowAll,
}: {
  load: ApprovedArtworkLoad
  projectName: string
  customerName: string
  materialDisplay: string | null
  /** Opens the card, where the full file list lives. Powers "+N more". */
  onShowAll?: () => void
}) {
  const [zipBusy, setZipBusy] = useState(false)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Say nothing until the batch has an answer, and say nothing if it failed:
  // a triage row is not the place to report a background read that the prep
  // form below will retry and explain properly the moment it's opened.
  if (load.status !== 'ready' || !load.artwork) return null
  const artwork: ApprovedArtwork = load.artwork

  const files = artwork.files

  // An ordered proof is approved, and an approved proof has artwork on its
  // current version — so nothing here is the anomaly, not the quiet case. Say
  // so rather than render nothing, which would be indistinguishable from the
  // batch still loading.
  if (files.length === 0) {
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--c-low-ink)]">
        <AlertTriangle size={13} aria-hidden="true" className="shrink-0" />
        No approved artwork found — open the proof to check.
      </p>
    )
  }

  // Two names, then a count. A shared front/back order — the common case — is
  // fully named; a ten-recipient set says how much more there is rather than
  // spilling a list nobody reads off a triage row, and "+N more" opens the card
  // so the rest is one click away rather than hidden.
  const shown = files.slice(0, 2)
  const rest = files.length - shown.length
  const allNames = files.map((f) => f.originalFilename ?? 'unnamed file')

  // The finish couldn't be narrowed, so this list is every proofed finish, not
  // the ordered one. The panel spells that out in full; here it only has to
  // stop the line reading as "these are the files" (and the ZIP's own manifest
  // carries the same caution into production).
  const uncertain = artwork.finishUncertain && artwork.finishTabCount > 1

  async function handleZip() {
    setError(null)
    setZipBusy(true)
    try {
      await downloadApprovedArtworkZip(artwork, { projectName, customerName, materialDisplay })
    } catch {
      setError('Couldn’t build the ZIP — please try again.')
    } finally {
      setZipBusy(false)
    }
  }

  async function handleFile(file: ApprovedArtworkFile) {
    setError(null)
    setBusyFileId(file.imageId)
    try {
      await downloadApprovedFile(file)
    } catch {
      setError('Couldn’t download that file — please try again.')
    } finally {
      setBusyFileId(null)
    }
  }

  return (
    // A named group, so the row announces what it is (the visual version says
    // it with a tick and the filenames) — and so the collapsed card's "one
    // visible primary + the ⋯ menu" rule can still be asserted against the
    // card's OWN actions: these controls are content, not a second route
    // through the order. See e2e/harness/orders-page.spec.ts.
    <div role="group" aria-label="Approved artwork" className="mt-2">
      {/* No flex-1 on the names: the row hugs its content, so the download
          button sits beside the filenames rather than stranded at the far edge
          of a card that's mostly empty space. It still shrinks (min-w-0 +
          truncate) when the names are long. */}
      <div className="flex min-w-0 items-center gap-2">
        {uncertain ? (
          <AlertTriangle size={13} aria-hidden="true" className="shrink-0 text-[var(--c-low-ink)]" />
        ) : (
          <Check size={13} strokeWidth={3} aria-hidden="true" className="shrink-0 text-in-stock" />
        )}
        {/* Each filename IS its download — the pair of facts wanted here is
            "what is it called" and "give it to me", and one control carries
            both without the panel's row-per-file height. */}
        <p className="min-w-0 truncate text-[12px] text-ink-soft" title={allNames.join('\n')}>
          {shown.map((f, i) => (
            <span key={f.imageId}>
              {i > 0 && <span className="text-ink-mute"> · </span>}
              <button
                type="button"
                onClick={() => void handleFile(f)}
                disabled={busyFileId === f.imageId || zipBusy}
                aria-label={`Download ${f.originalFilename ?? 'this approved file'}`}
                className="underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink-mute disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
              >
                {busyFileId === f.imageId ? 'Downloading…' : f.originalFilename ?? 'unnamed file'}
              </button>
            </span>
          ))}
          {rest > 0 && (
            <>
              <span className="text-ink-mute"> · </span>
              {onShowAll ? (
                <button
                  type="button"
                  onClick={onShowAll}
                  className="text-ink-mute underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                >
                  +{rest} more
                </button>
              ) : (
                <span className="text-ink-mute">+{rest} more</span>
              )}
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => void handleZip()}
          disabled={zipBusy}
          aria-label={`Download all ${files.length} approved artwork file${files.length === 1 ? '' : 's'} as a ZIP`}
          className="shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] text-ink-soft hover:bg-canvas disabled:opacity-50 max-md:min-h-[44px] max-md:px-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
        >
          {zipBusy ? 'Preparing…' : `All as ZIP (${files.length})`}
        </button>
      </div>
      {uncertain && (
        <p className="mt-0.5 text-[11px] text-[var(--c-low-ink)]">
          All {artwork.finishTabCount} proofed finishes — confirm which was ordered.
        </p>
      )}
      {error && <p className="mt-0.5 text-[11px] text-out">{error}</p>}
    </div>
  )
}
