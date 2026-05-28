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
import { lookupCardBySlug, VcardConfigError } from '../lib/vcardClient'
import { generateVcardQrSvg, parseVcardSlugInput, vcardUrlForSlug } from '../lib/vcardQr'
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
   * Hosted-vCard slug — only populated when kind = 'hosted_vcard'. The
   * canonical URL the QR encodes is vcardUrlForSlug(vcardSlug); we
   * keep both decodedData (the URL, for storage symmetry with all
   * other QR kinds) and vcardSlug (which is what qr_vcard_slug
   * persists). On save the parent writes both columns.
   */
  vcardSlug?: string
  /**
   * Human-readable label resolved at "Add" time via lookup_card_by_slug
   * — e.g. "Jane Smith, Acme Ltd". UI-only ("Found: …" read-back so
   * the designer can confirm they linked the right card); not
   * persisted. Re-resolved live by the customer page on render, so
   * staleness here doesn't propagate.
   */
  vcardCardName?: string | null
  /**
   * Cached SVG markup for the generated hosted-vCard QR. Populated at
   * "Add" time; used both for the thumbnail preview and the
   * "Download SVG" action. Re-derivable from vcardSlug at any moment,
   * but keeping it on the entry avoids re-running QRCode.toString on
   * every render.
   */
  vcardSvg?: string
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
  hosted_vcard: 'Plasma vCard',
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
  const vcardInputId = useId()
  const [dropError, setDropError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // Plasma vCard add-form state. Lives here rather than inside a
  // sub-component because the validate→generate→add sequence
  // resets local state and pushes a new entry into the parent's
  // `value` array — both concerns belong with the rest of the
  // QR section's add UI.
  const [vcardInput, setVcardInput] = useState('')
  const [vcardLoading, setVcardLoading] = useState(false)
  const [vcardError, setVcardError] = useState<string | null>(null)

  async function handleAddVcard() {
    setVcardError(null)
    const slug = parseVcardSlugInput(vcardInput)
    if (!slug) {
      setVcardError(
        'Paste a qcrd.uk URL (e.g. https://qcrd.uk/jane-smith) or the slug on its own.',
      )
      return
    }

    setVcardLoading(true)
    try {
      const lookup = await lookupCardBySlug(slug)
      if (!lookup.ok) {
        setVcardError(
          lookup.reason === 'not_found'
            ? `No Plasma vCard exists with the slug "${slug}". Check the URL or create the card in the vCard app first.`
            : `Couldn't reach the vCard app to verify the slug. ${lookup.message ?? ''}`.trim(),
        )
        return
      }

      const card = lookup.data
      const cardName =
        [card.first_name, card.last_name].filter(Boolean).join(' ').trim() ||
        card.company ||
        slug

      // Generate the QR SVG once and stash both the markup and a
      // File ready for the parent's save path. The File is the same
      // shape the upload path already understands; only the path
      // extension differs (.svg vs .jpg) and the parent picks that
      // by entry.kind.
      const svg = await generateVcardQrSvg(slug)
      const file = new File([svg], `${slug}.svg`, { type: 'image/svg+xml' })
      // Object URL for the inline preview. The parent's save flow
      // never reads previewUrl, so revoking it on Remove (existing
      // pattern below) is the only lifecycle concern.
      const previewUrl = URL.createObjectURL(file)

      const newEntry: QrEntry = {
        id: uuidv4(),
        source: 'new',
        file,
        previewUrl,
        decodedData: vcardUrlForSlug(slug),
        kind: 'hosted_vcard',
        associatedName: defaultRecipient ?? null,
        originalFilename: file.name,
        vcardSlug: slug,
        vcardCardName: cardName,
        vcardSvg: svg,
      }
      onChange([...value, newEntry])
      setVcardInput('')
    } catch (err) {
      if (err instanceof VcardConfigError) {
        setVcardError(
          'vCard app integration is not configured. Add VITE_VCARD_SUPABASE_URL and VITE_VCARD_SUPABASE_ANON_KEY to .env, then restart the dev server.',
        )
      } else {
        setVcardError(`Unexpected error: ${(err as Error).message}`)
      }
    } finally {
      setVcardLoading(false)
    }
  }

  function handleDownloadSvg(entry: QrEntry) {
    if (!entry.vcardSvg || !entry.vcardSlug) return
    const blob = new Blob([entry.vcardSvg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${entry.vcardSlug}-qr.svg`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoke after the click event has fired so the download
    // actually starts. setTimeout 0 is enough; the browser caches
    // the blob long enough to read it.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

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
    <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-dim">
          QR codes
        </h2>
        <span className="text-xs text-ink-dim">
          {value.length === 0 ? 'Optional' : `${value.length} attached`}
        </span>
      </div>
      <p className="mb-5 max-w-prose text-sm text-ink-soft">
        Add each QR code that appears on the card so the customer can verify it before approving. Use the customer-supplied path for QRs the customer sent (vCard, URL, wifi, etc.), or the Plasma vCard path when the QR points at a hosted qcrd.uk card.
      </p>

      <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-ink-dim">
        Customer-supplied QR
      </div>
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
          'flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragOver
            ? 'border-brand bg-brand-50'
            : 'border-line hover:border-line',
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
        <div className="mt-2 text-sm text-ink-soft">
          Drop QR images here, or <span className="font-semibold text-brand">browse</span>
        </div>
        <div className="mt-1 text-xs text-ink-mute">JPEG only, one file per QR code</div>
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept="image/jpeg"
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
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">
          {dropError}
        </p>
      )}

      {/* ── Plasma vCard QR add form ─────────────────────────────── */}
      <div className="mt-6 mb-3 text-[11px] font-semibold uppercase tracking-widest text-ink-dim">
        Plasma vCard QR
      </div>
      <div className="rounded-xl border border-line bg-canvas p-4">
        <p className="mb-3 max-w-prose text-xs text-ink-soft">
          Paste the qcrd.uk URL or slug of the Plasma vCard this QR points at. We'll generate the QR for the artwork and show the live contact details to the customer when they verify.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <input
            id={vcardInputId}
            type="text"
            value={vcardInput}
            onChange={(e) => setVcardInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleAddVcard()
              }
            }}
            placeholder="https://qcrd.uk/jane-smith or jane-smith"
            disabled={disabled || vcardLoading}
            className="flex-1 rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void handleAddVcard()}
            disabled={disabled || vcardLoading || !vcardInput.trim()}
            className="rounded bg-brand px-4 py-2 text-sm font-semibold text-on-ink shadow-sm hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            {vcardLoading ? 'Looking up…' : 'Look up + add'}
          </button>
        </div>
        {vcardError && (
          <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">
            {vcardError}
          </p>
        )}
      </div>

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
                    ? 'border-low bg-low-soft'
                    : 'border-line bg-canvas',
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
                        'aspect-square w-full max-w-[120px] rounded border border-line bg-surface object-contain transition-opacity',
                        ghosted ? 'opacity-40' : '',
                      ].join(' ')}
                    />
                  ) : (
                    <div className="aspect-square w-full max-w-[120px] rounded-md border border-dashed border-line bg-surface" />
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
                    <span className="inline-flex items-center gap-1 rounded-full bg-in-stock-soft px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-in-stock">
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 6.5L5 9L9.5 3.5"
                          stroke="var(--c-in-stock)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {entry.kind === 'hosted_vcard' ? 'Generated' : 'Decoded'}
                    </span>
                    <span
                      className={[
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
                        entry.kind === 'hosted_vcard'
                          ? 'bg-brand-50 text-brand'
                          : 'bg-line text-ink-soft',
                      ].join(' ')}
                    >
                      {KIND_LABELS[entry.kind]}
                    </span>
                    {entry.kind === 'hosted_vcard' && entry.vcardCardName && (
                      <span className="text-[12px] font-medium text-ink-soft">
                        {entry.vcardCardName}
                      </span>
                    )}
                    {entry.kind !== 'hosted_vcard' && entry.originalFilename && (
                      <span className="text-[12px] text-ink-mute" title={entry.originalFilename}>
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
                    <div className="mt-3 rounded-lg border border-low bg-low-soft px-3 py-2 text-[12px] leading-snug text-low">
                      <p className="font-medium">
                        Artwork has changed on the card this QR appears on.
                      </p>
                      <p className="mt-0.5">
                        {effectiveKeep
                          ? 'You\'ve ticked Keep — this QR will carry to the new version. Make sure the encoded data is still correct.'
                          : 'Upload a refreshed QR above, or tick Keep if you\'re certain the encoded data is unchanged.'}
                      </p>
                    </div>
                  )}
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-[12px] text-ink ring-1 ring-line">
                    {entry.decodedData}
                  </pre>
                  {entry.kind === 'hosted_vcard' && entry.vcardSvg && entry.source === 'new' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => handleDownloadSvg(entry)}
                        disabled={disabled}
                        className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        Download SVG for artwork
                      </button>
                    </div>
                  )}
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
                    <label className="mt-3 flex flex-col gap-1 text-[12px] text-ink-soft sm:flex-row sm:items-center sm:gap-2">
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
                        className="rounded border border-line bg-surface px-2 py-1 text-[13px] text-ink"
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
                    <label className="inline-flex items-center gap-2 text-[12px] text-ink-soft">
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
                          effectiveKeep ? 'bg-ink' : 'bg-line',
                          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'inline-block h-4 w-4 transform rounded-full bg-surface transition-transform',
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
                    className="rounded border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:border-out hover:text-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-out disabled:cursor-not-allowed disabled:opacity-50"
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
