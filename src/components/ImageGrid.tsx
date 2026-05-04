import type { KeyboardEvent } from 'react'
import { downloadBlob } from '../lib/downloadFile'

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
}

async function downloadImage(url: string, filename: string) {
  const resp = await fetch(url)
  const blob = await resp.blob()
  downloadBlob(blob, filename)
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
      className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
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
    <div className="border-t border-gray-100 px-4 py-2">
      {label && <div className="text-center text-sm text-gray-500">{label}</div>}
      <div className="mt-0.5 flex items-center justify-center gap-2">
        {filename && (
          <div className="min-w-0 truncate text-xs text-gray-400" title={filename}>
            {filename}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            downloadImage(signedUrl, filename ?? 'proof.jpg')
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
            <path fillRule="evenodd" d="M10 3a.75.75 0 0 1 .75.75v8.69l2.72-2.72a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06l2.72 2.72V3.75A.75.75 0 0 1 10 3Zm-6 12.25a.75.75 0 0 1 .75.75v.25c0 .414.336.75.75.75h9c.414 0 .75-.336.75-.75V16a.75.75 0 0 1 1.5 0v.25A2.25 2.25 0 0 1 14.5 18.5h-9A2.25 2.25 0 0 1 3.25 16.25V16a.75.75 0 0 1 .75-.75Z" clipRule="evenodd" />
          </svg>
          Download
        </button>
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
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
        <div className="flex h-64 items-center justify-center text-gray-400">
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
        className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
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
            className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
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
