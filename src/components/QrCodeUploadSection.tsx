// Designer-side QR upload section for the version forms.
//
// Renders between Proof Images and Change Notes. Designer drops a
// QR JPEG; the component runs jsQR client-side via
// decodeQrFromFile (src/lib/qrCodes.ts), shows a green tick + the
// decoded contents inline when the decode succeeds, or a rose-
// toned error when no QR pattern is found. The customer never
// sees an undecodable QR — it never makes it past this gate.
//
// State is controlled by the parent (NewVersionPage /
// EditVersionPage) so the version-save flow can iterate the
// entries at commit time: existing rows (carried from v1) ride
// through unchanged, new entries upload their File then INSERT a
// proof_version_images row with is_qr_code = true, removed
// entries DELETE.
//
// Per-recipient assignment uses the same associated_name pattern
// as the artwork image grid — null = shared (applies to every
// printed copy), a recipient name = scoped to that card. The
// dropdown defaults to whatever the parent passes via
// `defaultRecipient`, falling back to 'shared'.

import { useId, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  decodeQrFromFile,
  QrDecodeError,
  type QrKind,
} from '../lib/qrCodes'
import { SHARED_APPROVAL_KEY } from '../lib/types'

/**
 * A QR row known to the designer form. Mirrors the proof_version_images
 * shape: an existing entry has the storage path of the previously-
 * saved row, a new entry has a File ready to upload. Either way it
 * carries the decoded payload + classifier output, which the parent
 * writes verbatim to qr_decoded_data and qr_kind on save.
 */
export interface QrEntry {
  /** Stable local id. UUID for fresh entries, mirrors row id for existing ones. */
  id: string
  /** Either 'new' (uploaded in this session) or 'existing' (carried from a prior save). */
  source: 'new' | 'existing'
  /** Storage path of the saved row (existing only). */
  imagePath?: string
  /** File to upload at save (new only). */
  file?: File
  /** Object URL for the preview thumbnail (new only — existing entries use the parent-supplied signedUrl). */
  previewUrl?: string
  /** Signed URL for the preview thumbnail (existing only). */
  signedUrl?: string
  /** Raw decoded payload — written to qr_decoded_data on save. */
  decodedData: string
  /** Classifier output — written to qr_kind on save. */
  kind: QrKind
  /** Recipient assignment. Null = shared across all printed copies. */
  associatedName: string | null
  /** Original filename for audit, populated from file.name on new entries. */
  originalFilename: string | null
  /**
   * Effective Keep state for existing entries on the new-version
   * form. When false, the entry is ghosted in the UI and the parent
   * skips it at save time so v1's QR is dropped from v2. Computed by
   * the parent from its qrKeepOverrides + per-slot artwork-changed
   * detection — the component just renders what it's given. Undefined
   * for new entries and for callers (like EditVersionPage) that
   * aren't doing carry-forward; the component treats undefined as
   * "no toggle, behave like the entry is being kept".
   */
  keep?: boolean
  /**
   * True when the printed surface this QR appears on has had its
   * artwork modified between v1 and v2 (image dropped, replaced, or
   * a fresh image added to the slot, or the slot itself disappeared
   * via a names/shape change). Drives the amber re-verify notice and
   * the auto-default of `keep` to false — the parent sets both
   * together. Always false / undefined for new entries.
   */
  artworkChanged?: boolean
}

interface QrCodeUploadSectionProps {
  value: QrEntry[]
  onChange: (next: QrEntry[]) => void
  /** Recipient roster on the current version. Empty for shared-only versions. */
  names: string[]
  /** Recipient to pre-select on a new entry. Null = shared. */
  defaultRecipient?: string | null
  /** Disabled while the parent is saving. */
  disabled?: boolean
  /**
   * Opt-in for the per-entry Keep toggle on the new-version form.
   * When provided, existing entries render a Keep switch and the
   * component routes toggle clicks here instead of mutating
   * `value`; the parent's qrKeepOverrides + slot-changed
   * derivations remain the single source of truth for effective
   * keep state. Omitted everywhere else (EditVersionPage etc.), in
   * which case no toggle is rendered and behaviour is unchanged.
   */
  onKeepChange?: (entryId: string, keep: boolean) => void
}

const KIND_LABELS: Record<QrKind, string> = {
  vcard: 'Contact card',
  mecard: 'Contact card',
  url: 'Website link',
  wifi: 'Wifi network',
  email: 'Email address',
  phone: 'Phone number',
  sms: 'Text message',
  text: 'Plain text',
}

export function QrCodeUploadSection({
  value,
  onChange,
  names,
  defaultRecipient = null,
  disabled = false,
  onKeepChange,
}: QrCodeUploadSectionProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const inputId = useId()
  const [dropError, setDropError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  async function handleFiles(fileList: FileList | File[]) {
    setDropError(null)
    const arr = Array.from(fileList)
    const accepted: QrEntry[] = []
    const rejected: { name: string; reason: string }[] = []

    for (const file of arr) {
      try {
        const decoded = await decodeQrFromFile(file)
        accepted.push({
          id: uuidv4(),
          source: 'new',
          file,
          previewUrl: URL.createObjectURL(file),
          decodedData: decoded.data,
          kind: decoded.kind,
          associatedName: defaultRecipient ?? null,
          originalFilename: file.name,
        })
      } catch (err) {
        const reason = err instanceof QrDecodeError ? err.message : 'Unknown decode error.'
        rejected.push({ name: file.name, reason })
      }
    }

    if (accepted.length > 0) onChange([...value, ...accepted])
    if (rejected.length > 0) {
      setDropError(
        rejected
          .map((r) => `${r.name}: ${r.reason}`)
          .join(' · '),
      )
    }
  }

  function updateEntry(id: string, patch: Partial<QrEntry>) {
    onChange(value.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  function removeEntry(id: string) {
    const target = value.find((e) => e.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    onChange(value.filter((e) => e.id !== id))
  }

  return (
    <section className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          QR codes
        </h2>
        <span className="text-xs text-gray-400">
          {value.length === 0 ? 'Optional' : `${value.length} attached`}
        </span>
      </div>
      <p className="mb-5 max-w-prose text-sm text-gray-600">
        Drop a JPEG of each QR code that appears on the card. The decoded contents are stored alongside the image and shown to the customer for verification before they approve. Files that don't contain a readable QR are rejected.
      </p>

      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          // Stop the native event too so the page-wide
          // useImageFileDrop window listener doesn't also flag
          // its overlay as drag-over for this QR drop.
          e.nativeEvent.stopPropagation()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          // Critical: stop the NATIVE event from bubbling to
          // window. useImageFileDrop attaches its drop handler
          // at the window level (bubble phase), so a React
          // stopPropagation alone leaves the window listener
          // intact and the QR file gets routed into the artwork
          // bucket too. Mirrors the same fix the cell-level
          // drop targets (CarryCard, EmptySlot) use to avoid
          // double-routing into addFilesBatch.
          e.nativeEvent.stopPropagation()
          setDragOver(false)
          if (disabled) return
          void handleFiles(e.dataTransfer.files)
        }}
        className={[
          'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragOver
            ? 'border-violet-400 bg-violet-50'
            : 'border-gray-300 hover:border-gray-400',
          disabled ? 'pointer-events-none opacity-60' : '',
        ].join(' ')}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm14 0h2v2h-2v-2Zm-3 0h2v2h-2v-2Zm6 3h2v2h-2v-2Zm-3 0h2v2h-2v-2Zm-3 3h2v2h-2v-2Zm3 0h2v2h-2v-2Zm3 0h2v2h-2v-2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
        <div className="mt-2 text-sm text-gray-700">
          Drop QR images here, or <span className="font-semibold text-violet-700">browse</span>
        </div>
        <div className="mt-1 text-xs text-gray-500">JPEG or PNG, one file per QR code</div>
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          disabled={disabled}
          onChange={(e) => {
            if (!e.target.files) return
            void handleFiles(e.target.files)
            // Reset so re-selecting the same file fires onChange.
            e.target.value = ''
          }}
        />
      </label>

      {dropError && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {dropError}
        </p>
      )}

      {value.length > 0 && (
        <ul className="mt-6 space-y-4">
          {value.map((entry) => {
            const thumbnail = entry.previewUrl ?? entry.signedUrl ?? ''
            // showKeepToggle is the carry-forward UI opt-in. Present
            // only when the parent passed onKeepChange (i.e. the
            // new-version form) AND the entry is an existing v1
            // carry. New entries always upload if they're in the
            // list; Remove is their disposal route.
            const showKeepToggle = !!onKeepChange && entry.source === 'existing'
            const effectiveKeep = entry.keep ?? true
            const ghosted = showKeepToggle && !effectiveKeep
            const showArtworkChangedNotice = entry.artworkChanged === true
            return (
              <li
                key={entry.id}
                className={[
                  'grid gap-4 rounded-xl border p-4 sm:grid-cols-[120px_1fr_auto] transition-colors',
                  showArtworkChangedNotice
                    ? 'border-amber-200 bg-amber-50/60'
                    : 'border-gray-200 bg-gray-50',
                ].join(' ')}
              >
                <div className="grid place-items-center">
                  {thumbnail ? (
                    <img
                      src={thumbnail}
                      alt="QR preview"
                      width={120}
                      height={120}
                      className={[
                        'aspect-square w-full max-w-[120px] rounded-md border border-gray-200 bg-white object-contain transition-opacity',
                        ghosted ? 'opacity-40' : '',
                      ].join(' ')}
                    />
                  ) : (
                    <div className="aspect-square w-full max-w-[120px] rounded-md border border-dashed border-gray-300 bg-white" />
                  )}
                </div>
                {/*
                  Content column stays at full opacity even when the
                  entry is ghosted — the amber re-verify notice is the
                  highest-priority signal in this state and needs to
                  be legible. The thumbnail above handles the "this
                  QR won't be carried" visual cue via its own dim
                  state; replicating the dim across the warning copy
                  made the alert read as if it had been dismissed.
                */}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-800">
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 6.5L5 9L9.5 3.5"
                          stroke="#0c5e3a"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Decoded
                    </span>
                    <span className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-700">
                      {KIND_LABELS[entry.kind]}
                    </span>
                    {entry.originalFilename && (
                      <span className="text-[12px] text-gray-500" title={entry.originalFilename}>
                        {entry.originalFilename}
                      </span>
                    )}
                  </div>
                  {/*
                    Artwork-changed notice. Renders when the parent has
                    flagged this QR's printed surface as modified
                    between v1 and v2 (image dropped, replaced, fresh
                    image added, or slot vanished via names/shape
                    change). Wording shifts based on whether the
                    designer has re-ticked Keep: pre-re-tick we ask
                    them to upload or confirm; post-re-tick we reflect
                    their explicit choice. Either way the customer
                    still has to re-tick the on-page confirmation
                    because their slot's approval doesn't carry when
                    the artwork changed (NewVersionPage allCarried
                    gate), so this is a designer-side prompt, not a
                    structural safety on its own.
                  */}
                  {showArtworkChangedNotice && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900">
                      <p className="font-medium">
                        Artwork has changed on the card this QR appears on.
                      </p>
                      <p className="mt-0.5">
                        {effectiveKeep
                          ? 'You\'ve ticked Keep — this QR will carry to the new version. Make sure the encoded data is still correct.'
                          : 'Upload a refreshed QR above, or tick Keep below if you\'re certain the encoded data is unchanged.'}
                      </p>
                    </div>
                  )}
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[12px] text-gray-800 ring-1 ring-gray-200">
                    {entry.decodedData}
                  </pre>
                  {names.length > 1 && (
                    // Only render the dropdown when there are
                    // 2+ recipients. For single-recipient proofs,
                    // shared vs that one recipient resolves to the
                    // same customer-page placement and the same
                    // approval-slot QR coordinates, so offering the
                    // choice is confusing rather than informative.
                    // The entry keeps associatedName at its default
                    // (null / shared) on single-recipient versions;
                    // the customer page still renders the QR under
                    // the recipient's section via the shared branch.
                    <label className="mt-3 flex flex-col gap-1 text-[12px] text-gray-600 sm:flex-row sm:items-center sm:gap-2">
                      Applies to
                      <select
                        value={entry.associatedName ?? SHARED_APPROVAL_KEY}
                        disabled={disabled}
                        onChange={(e) =>
                          updateEntry(entry.id, {
                            associatedName:
                              e.target.value === SHARED_APPROVAL_KEY ? null : e.target.value,
                          })
                        }
                        className="rounded border border-gray-300 bg-white px-2 py-1 text-[13px] text-gray-900"
                      >
                        <option value={SHARED_APPROVAL_KEY}>All recipients (shared)</option>
                        {names.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex items-start gap-2 sm:flex-col sm:items-end sm:justify-between sm:gap-3">
                  {/*
                    Keep toggle — only rendered on existing entries in
                    the new-version form. Mirrors the artwork
                    CarryCard toggle so the two carry-forward
                    surfaces feel consistent. Toggling routes through
                    onKeepChange so the parent's qrKeepOverrides map
                    stays the source of truth (the entry object the
                    component receives is a per-render derivation,
                    not committed state).
                  */}
                  {showKeepToggle && (
                    <label className="inline-flex items-center gap-2 text-[12px] text-gray-700">
                      <span>Keep</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={effectiveKeep}
                        aria-label="Keep this QR on the new version"
                        disabled={disabled}
                        onClick={() => onKeepChange!(entry.id, !effectiveKeep)}
                        className={[
                          'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                          effectiveKeep ? 'bg-gray-900' : 'bg-gray-300',
                          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                            effectiveKeep
                              ? 'translate-x-[1.125rem] translate-y-0.5'
                              : 'translate-x-0.5 translate-y-0.5',
                          ].join(' ')}
                        />
                      </button>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id)}
                    disabled={disabled}
                    className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-700 hover:border-rose-400 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
