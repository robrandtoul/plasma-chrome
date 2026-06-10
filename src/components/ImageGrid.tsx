import type { KeyboardEvent } from 'react'
import { withDownloadName } from '../lib/downloadFile'

// Shared keyboard handler for the click-to-zoom card wrappers.
// Wrappers are <div role="button"> rather than real <button>
// elements because they contain a nested <button> for Download
// (button-in-button is invalid HTML); div + role + tabIndex +
// keydown is the standard escape hatch and is announced as
// interactive by screen readers.
function activateOnEnterOrSpace(onActivate: () => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate()
    }
  }
}

export interface GridImage {
  id: string
  signed_url: string
  // Caption under each thumb. Optional because the DB no longer
  // stores this — callers synthesise it (e.g. CustomerProofPage
  // buildImageGroups rewrites it from side / filename per image,
  // VersionDetailModal omits it and Caption reads as blank).
  label?: string
  material_option?: string | null
  original_filename?: string | null
  associated_name?: string | null
  side?: 'front' | 'back' | null
  // Migration 000139: variant a customer-page image belongs to on a
  // variant-round version. customer-proof-images returns the row
  // verbatim (select *), so this is already populated when the
  // parent version has is_variant_round = true. Null on every image
  // of a standard version.
  round_variant_id?: string | null
  // Migration 000210: layout a customer-page image belongs to on a Set
  // (collection) version. customer-proof-images returns the row verbatim
  // (select *), so this is already populated when the parent version is
  // shape='set_collection'. Null on every other shape's images.
  layout_id?: string | null
  // public_proof_version_images exposes sort_order (000014); the
  // edge function passes it through. Optional because not every
  // call site reads it — the customer-page variant-round render
  // path uses it to order images within a variant card.
  sort_order?: number
  // Migration 000168: QR-code flag and decoded payload. A row with
  // is_qr_code=true is rendered by the dedicated QR panel, not the
  // image grid, so every consumer of GridImage that builds artwork
  // grids must filter is_qr_code=false up front. qr_decoded_data
  // and qr_kind are populated iff is_qr_code is true (DB CHECK
  // constraint), so the customer page can treat them as guaranteed
  // present whenever it iterates over QR rows. Optional here
  // because legacy rows and pre-migration test fixtures default to
  // is_qr_code=false with both QR columns null.
  is_qr_code?: boolean
  qr_decoded_data?: string | null
  qr_kind?: 'vcard' | 'url' | 'wifi' | 'mecard' | 'email' | 'phone' | 'sms' | 'text' | 'hosted_vcard' | null
  // Migration 000192: only populated when qr_kind = 'hosted_vcard'. The
  // customer-side QR panel uses this to fetch live contact details
  // from the vCard app's anon RPCs and render them for verification.
  qr_vcard_slug?: string | null
}

// Single-image card with click-to-zoom + caption. Exported so the
// customer proof page can render its own layout (hero block for
// Shared imagery, per-name grid cells for named groups) without
// reusing ImageGrid's built-in 1-vs-many layout rules.
export function ImageCard({
  image,
  alt,
  onClick,
}: {
  image: GridImage
  alt: string
  onClick: (src: string) => void
}) {
  const activate = () => onClick(image.signed_url)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${alt} at full size`}
      className="cursor-zoom-in overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      onClick={activate}
      onKeyDown={activateOnEnterOrSpace(activate)}
    >
      <img
        src={image.signed_url}
        alt={alt}
        className="w-full object-contain"
      />
      <Caption label={image.label ?? ''} filename={image.original_filename} signedUrl={image.signed_url} />
    </div>
  )
}

function Caption({ label, filename, signedUrl }: { label: string; filename?: string | null; signedUrl: string }) {
  if (!label && !filename) return null
  return (
    <div className="border-t border-line-soft px-4 py-2">
      {label && <div className="text-center text-sm text-ink-mute">{label}</div>}
      <div className="mt-0.5 flex items-center justify-center gap-2">
        {filename && (
          <div className="min-w-0 truncate text-xs text-ink-dim" title={filename}>
            {filename}
          </div>
        )}
        {/* Anchor-based download — same pattern as PlateCard on the
            customer page. Skips the fetch-then-blob round-trip the
            previous implementation needed for the click handler,
            which was slow on large proof images and gave no in-flight
            feedback. As a side-effect this also drops the double-
            click race the old fetch path could trigger. target="_blank"
            + rel="noopener" is the graceful fallback when the browser
            ignores the download attribute on a cross-origin URL. */}
        <a
          href={withDownloadName(signedUrl, filename ?? 'proof.jpg')}
          download={filename ?? 'proof.jpg'}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-ink-soft ring-1 ring-line hover:bg-canvas"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
            <path fillRule="evenodd" d="M10 3a.75.75 0 0 1 .75.75v8.69l2.72-2.72a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06l2.72 2.72V3.75A.75.75 0 0 1 10 3Zm-6 12.25a.75.75 0 0 1 .75.75v.25c0 .414.336.75.75.75h9c.414 0 .75-.336.75-.75V16a.75.75 0 0 1 1.5 0v.25A2.25 2.25 0 0 1 14.5 18.5h-9A2.25 2.25 0 0 1 3.25 16.25V16a.75.75 0 0 1 .75-.75Z" clipRule="evenodd" />
          </svg>
          Download
        </a>
      </div>
    </div>
  )
}

export function ImageGrid({
  images,
  versionNumber,
  onImageClick,
}: {
  images: GridImage[]
  versionNumber: number
  onImageClick: (src: string) => void
}) {
  if (images.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
        <div className="flex h-64 items-center justify-center text-ink-dim">
          Image unavailable
        </div>
      </div>
    )
  }

  if (images.length === 1) {
    const only = images[0]
    const altText = only.label || `Proof version ${versionNumber}`
    const activate = () => onImageClick(only.signed_url)
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${altText} at full size`}
        className="cursor-zoom-in overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={activate}
        onKeyDown={activateOnEnterOrSpace(activate)}
      >
        <img
          src={only.signed_url}
          alt={altText}
          className="w-full object-contain"
        />
        <Caption label={only.label ?? ''} filename={only.original_filename} signedUrl={only.signed_url} />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {images.map((img) => {
        const altText = img.label || `Proof version ${versionNumber}`
        const activate = () => onImageClick(img.signed_url)
        return (
          <div
            key={img.id}
            role="button"
            tabIndex={0}
            aria-label={`Open ${altText} at full size`}
            className="cursor-zoom-in overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            onClick={activate}
            onKeyDown={activateOnEnterOrSpace(activate)}
          >
            <img
              src={img.signed_url}
              alt={altText}
              className="w-full object-contain"
            />
            <Caption label={img.label ?? ''} filename={img.original_filename} signedUrl={img.signed_url} />
          </div>
        )
      })}
    </div>
  )
}
