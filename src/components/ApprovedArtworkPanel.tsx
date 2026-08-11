import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
  fetchApprovedArtwork,
  downloadApprovedFile,
  downloadApprovedArtworkZip,
  fileRowMeta,
  type ApprovedArtworkLoad,
} from '../lib/approvedArtwork'

// The approved artwork for an order, shown in the To-order card's prep area so
// the designer can grab the production files (and see when they were approved)
// without opening the proof. Mirrors the proof detail page's "Approved artwork"
// section: the file list, per-file downloads, and a "Download all as ZIP"
// hand-off (original filenames preserved).
//
// Takes the artwork preloaded when the caller already has it — the Orders page
// batches every card's files in one go for the collapsed one-line strip, so
// expanding a card must not go and fetch the same thing again (and must not be
// able to show a DIFFERENT answer from the line it replaces). Falls back to
// fetching on mount for any caller without a batch.

function formatApprovedDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function ApprovedArtworkPanel({
  proofId,
  projectName,
  customerName,
  materialDisplay,
  materialOptionId,
  preloaded,
}: {
  proofId: string
  projectName: string
  customerName: string
  materialDisplay: string | null
  // The order's chosen finish. A proof shown in three metal finishes carries
  // three images per side; only the ordered one is this order's artwork.
  materialOptionId: string | null
  // The caller's batch load for this order. Omitted = fetch it here.
  preloaded?: ApprovedArtworkLoad
}) {
  const [own, setOwn] = useState<ApprovedArtworkLoad>({ status: 'loading' })
  const [zipBusy, setZipBusy] = useState(false)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (preloaded) return
    let cancelled = false
    setOwn({ status: 'loading' })
    fetchApprovedArtwork(proofId, { materialOptionId })
      .then((a) => { if (!cancelled) setOwn({ status: 'ready', artwork: a }) })
      .catch(() => { if (!cancelled) setOwn({ status: 'error' }) })
    return () => { cancelled = true }
  }, [proofId, materialOptionId, preloaded])

  const load = preloaded ?? own
  const artwork = load.status === 'ready' ? load.artwork : null
  const loading = load.status === 'loading'
  const loadError = load.status === 'error'

  async function handleZip() {
    if (!artwork) return
    setActionError(null)
    setZipBusy(true)
    try {
      await downloadApprovedArtworkZip(artwork, { projectName, customerName, materialDisplay })
    } catch {
      setActionError('Couldn’t build the ZIP — please try again.')
    } finally {
      setZipBusy(false)
    }
  }

  async function handleFile(fileId: string) {
    if (!artwork) return
    const file = artwork.files.find((f) => f.imageId === fileId)
    if (!file) return
    setActionError(null)
    setBusyFileId(fileId)
    try {
      await downloadApprovedFile(file)
    } catch {
      setActionError('Couldn’t download that file — please try again.')
    } finally {
      setBusyFileId(null)
    }
  }

  const approvedLabel = formatApprovedDate(artwork?.approvedAt ?? null)
  const files = artwork?.files ?? []
  const hasFiles = !loading && !loadError && files.length > 0

  return (
    <div className="mt-3">
      {hasFiles ? (
        // Approved state: frame the section in the app's approved-green (the
        // same in-stock token the status pill uses) so the designer sees at a
        // glance these are the signed-off production files. A left status-rule
        // plus a tinted header strip carry the signal; the file rows stay on
        // white so filenames and the download buttons keep full contrast.
        <div
          className="overflow-hidden rounded-lg border border-line"
          style={{ borderLeft: '4px solid var(--c-in-stock)' }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-in-stock-soft px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-in-stock">
              <Check size={13} strokeWidth={3} aria-hidden="true" />
              Approved artwork
              {/* The finish these files are for. A proof shown in several
                  finishes carries a set per finish, and only one was ordered —
                  naming it here stops the narrowing looking like missing
                  files. */}
              {artwork?.finishLabel && (
                <span className="rounded-[4px] bg-surface px-1.5 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-in-stock">
                  {artwork.finishLabel}
                </span>
              )}
            </span>
            {approvedLabel && (
              <span className="text-[11px] font-medium text-in-stock">Approved {approvedLabel}</span>
            )}
          </div>

          {/* Couldn't narrow to the ordered finish, so this is every proofed
              finish — say so rather than let the reviewer hand production a
              set that's mostly cards the customer didn't buy. */}
          {artwork?.finishUncertain && artwork.finishTabCount > 1 && (
            <p className="border-b border-low bg-low-soft px-3 py-2 text-[12px] text-ink-soft">
              {artwork.finishScope === 'finish-missing'
                ? `This order's finish isn't one of the ${artwork.finishTabCount} proofed here, so all of them are listed.`
                : `This order doesn't record which of the ${artwork.finishTabCount} proofed finishes was bought, so all of them are listed.`}{' '}
              Confirm the finish before handing these to production.
            </p>
          )}

          <ul className="divide-y divide-line-soft bg-surface">
            {files.map((f) => (
              <li key={f.imageId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-ink">
                    {f.originalFilename ?? <span className="italic text-ink-mute">— (no filename captured)</span>}
                  </p>
                  <p className="text-[11px] text-ink-mute">
                    {fileRowMeta(f, {
                      isAllShared: artwork?.isAllShared ?? false,
                      isOneSided: artwork?.isOneSided ?? false,
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleFile(f.imageId)}
                  disabled={busyFileId === f.imageId || zipBusy}
                  className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-soft hover:bg-canvas disabled:opacity-50"
                >
                  {busyFileId === f.imageId ? 'Downloading…' : 'Download'}
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-line-soft bg-surface px-3 pb-3 pt-2">
            <p className="text-[11px] text-ink-mute">
              Filenames match the source artwork — don’t rename them.
            </p>
            <button
              type="button"
              onClick={() => void handleZip()}
              disabled={zipBusy}
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-on-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 max-md:h-11 max-md:w-full max-md:justify-center"
            >
              {zipBusy && (
                <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-ink/40 border-t-white" />
              )}
              {zipBusy ? 'Preparing ZIP…' : `Download all as ZIP${files.length > 1 ? ` (${files.length})` : ''}`}
            </button>
            {actionError && <p className="mt-1 text-[12px] text-out">{actionError}</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Approved artwork</span>
          </div>
          {loading ? (
            <p className="mt-1 text-[13px] text-ink-mute">Loading approved files…</p>
          ) : loadError ? (
            <p className="mt-1 text-[13px] text-out">Couldn’t load the approved files.</p>
          ) : (
            <p className="mt-1 text-[13px] text-ink-mute">No approved files found for the current version.</p>
          )}
        </>
      )}
    </div>
  )
}
