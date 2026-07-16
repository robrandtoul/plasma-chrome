import { useEffect, useState } from 'react'
import {
  fetchApprovedArtwork,
  downloadApprovedFile,
  downloadApprovedArtworkZip,
  fileRowMeta,
  type ApprovedArtwork,
} from '../lib/approvedArtwork'

// The approved artwork for an order, shown in the To-order card's prep area so
// the designer can grab the production files (and see when they were approved)
// without opening the proof. Mirrors the proof detail page's "Approved artwork"
// section: the file list, per-file downloads, and a "Download all as ZIP"
// hand-off (original filenames preserved).
//
// Mounts lazily (only when the card is expanded), so it fetches on mount rather
// than eagerly for every order in the queue.

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
}: {
  proofId: string
  projectName: string
  customerName: string
  materialDisplay: string | null
}) {
  const [artwork, setArtwork] = useState<ApprovedArtwork | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [zipBusy, setZipBusy] = useState(false)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    fetchApprovedArtwork(proofId)
      .then((a) => { if (!cancelled) { setArtwork(a); setLoading(false) } })
      .catch(() => { if (!cancelled) { setLoadError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [proofId])

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

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Approved artwork</span>
        {approvedLabel && <span className="text-[11px] text-ink-mute">Approved {approvedLabel}</span>}
      </div>

      {loading ? (
        <p className="mt-1 text-[13px] text-ink-mute">Loading approved files…</p>
      ) : loadError ? (
        <p className="mt-1 text-[13px] text-out">Couldn’t load the approved files.</p>
      ) : !artwork || artwork.files.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-mute">No approved files found for the current version.</p>
      ) : (
        <>
          <div className="mt-1 overflow-hidden rounded-lg border border-line bg-canvas">
            <ul className="divide-y divide-line-soft">
              {artwork.files.map((f) => (
                <li key={f.imageId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-ink">
                      {f.originalFilename ?? <span className="italic text-ink-mute">— (no filename captured)</span>}
                    </p>
                    <p className="text-[11px] text-ink-mute">
                      {fileRowMeta(f, { isAllShared: artwork.isAllShared, isOneSided: artwork.isOneSided })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFile(f.imageId)}
                    disabled={busyFileId === f.imageId || zipBusy}
                    className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-surface disabled:opacity-50"
                  >
                    {busyFileId === f.imageId ? 'Downloading…' : 'Download'}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-1 text-[11px] text-ink-mute">
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
            {zipBusy ? 'Preparing ZIP…' : `Download all as ZIP${artwork.files.length > 1 ? ` (${artwork.files.length})` : ''}`}
          </button>

          {actionError && <p className="mt-1 text-[12px] text-out">{actionError}</p>}
        </>
      )}
    </div>
  )
}
