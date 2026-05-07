import { useEffect, useRef, useState, type DragEvent } from 'react'

// True only for OS-originated drags (file → window). Internal
// HTML-typed drags (e.g. thumbnail reorder) carry no 'Files' entry.
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}

const ACCEPTED_TYPES = ['image/jpeg']

interface VariantDropZoneProps {
  label: string
  files: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  invalid?: boolean
  invalidText?: string
}

// Per-variant drop zone for the New Version page's variant editor.
//
// Combines a real drag-and-drop target with a click-to-browse
// fallback (hidden file input). Local drag-over state is tracked
// per zone — variant rounds typically render 2-4 of these on the
// page so each instance keeps its own visual state. No window-
// level listeners are attached; the standard image bucket on the
// same form has its own page-level overlay via useImageFileDrop,
// and adding more would double the listeners.
//
// JPEG-only client-side filter mirrors the proof-images storage
// bucket constraint (which rejects PNG / GIF / etc. on upload).
// Non-JPEG files are silently dropped from the accepted set; the
// inline error surfaces only when the drop attempt would have
// added zero accepted files (i.e. the user tried to drop only
// rejected types). Mixed drops (one JPEG + one PNG) accept the
// JPEG and show no error — the PNG just gets ignored.
export function VariantDropZone({
  label,
  files,
  onAddFiles,
  onRemoveFile,
  invalid,
  invalidText,
}: VariantDropZoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Per-file blob URLs for thumbnail rendering. Created once per
  // file via URL.createObjectURL after every files-prop change, and
  // revoked on the next change (or on unmount) so a designer who
  // adds/removes a long sequence of files doesn't leak object URLs.
  // The one-frame gap between files updating and blobUrls catching
  // up is invisible at human reaction time — thumbnails just
  // appear once the effect runs.
  const [blobUrls, setBlobUrls] = useState<string[]>([])
  useEffect(() => {
    const next = files.map((f) => URL.createObjectURL(f))
    setBlobUrls(next)
    return () => {
      for (const url of next) URL.revokeObjectURL(url)
    }
  }, [files])

  function accept(picked: File[]) {
    const accepted = picked.filter((f) => ACCEPTED_TYPES.includes(f.type))
    if (accepted.length === 0 && picked.length > 0) {
      setDropError('Only JPEG images are accepted.')
      return
    }
    setDropError(null)
    if (accepted.length > 0) onAddFiles(accepted)
  }

  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    setDragOver(true)
  }
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
  }
  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e.dataTransfer)) return
    setDragOver(false)
  }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    accept(Array.from(e.dataTransfer.files ?? []))
  }

  return (
    <div>
      <label
        className="mb-1.5 block text-sm font-medium text-gray-700"
        style={{ letterSpacing: '0.02em' }}
      >
        {label}
      </label>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          'flex min-h-[88px] cursor-pointer items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400',
          dragOver
            ? 'border-gray-900 bg-gray-50 text-gray-900'
            : invalid
              ? 'border-rose-300 bg-white text-rose-500 hover:border-rose-400'
              : 'border-gray-300 bg-white text-gray-500 hover:border-gray-400 hover:text-gray-700',
        ].join(' ')}
      >
        {dragOver
          ? 'Release to add'
          : 'Drop images here or click to browse'}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            if (picked.length === 0) return
            accept(picked)
            // Reset so the same file can be re-picked after a remove.
            e.target.value = ''
          }}
        />
      </div>
      {(dropError || (invalid && invalidText)) && (
        <p className="mt-1.5 text-xs font-medium text-rose-500">
          {dropError ?? invalidText}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.map((f, fi) => {
            // file.name is the user's original filename — set at File
            // construction time (browser drag-drop / file picker) and
            // not mutated by this form. The storage-path UUID lives
            // separately on each upload (proofId/{uuidv4}.jpg) and
            // doesn't surface here.
            const blobUrl = blobUrls[fi]
            return (
              <li
                key={`${f.name}-${fi}`}
                className="flex items-center gap-3 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs"
              >
                {blobUrl ? (
                  <img
                    src={blobUrl}
                    alt=""
                    aria-hidden="true"
                    className="h-32 w-32 shrink-0 rounded-md border border-gray-200 object-cover"
                  />
                ) : (
                  <div
                    className="h-32 w-32 shrink-0 rounded-md border border-gray-200 bg-gray-50"
                    aria-hidden="true"
                  />
                )}
                <span className="flex-1 truncate" title={f.name}>{f.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(fi)}
                  className="ml-2 shrink-0 text-gray-500 hover:text-rose-600"
                  aria-label={`Remove ${f.name}`}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
