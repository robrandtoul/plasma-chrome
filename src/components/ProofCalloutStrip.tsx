// The customer-facing note strip.
//
// This is the ONLY thing designer callouts add to the proof overview, and it
// carries no marks: the card above it stays exactly as it would look with the
// feature off. Each note brings its own cropped detail so the customer can see
// what is being discussed without the full card being annotated.
//
// Closed by default. Labelled with the designer's first name ("A note from
// Rob") rather than "your designer" — a named person who made something reads
// as craft; an anonymous system note reads as a caveat.
//
// One thing this deliberately is NOT: a record of disclosure. Notes are opt-in
// to read, so anything that must be acknowledged belongs in the approval
// disclaimer tick instead. See docs/proof-annotation-proposal.md §4.2.

import { useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { calloutStripLabel, cropStyle, type CustomerCallout } from '../lib/proofAnnotations'

interface Props {
  /**
   * Collapsed presentation, for a secondary position on the page. Notes are
   * EXPANDED by default: they sit above the approve / request-changes decision
   * and inform it, so hiding them behind a click meant customers approved
   * without ever seeing them.
   */
  startCollapsed?: boolean
  callouts: CustomerCallout[]
  /** Signed URL per proof_version_image_id, for the cropped details. */
  imageUrls: Record<string, string | undefined>
  /** Opens the zoom view at this note. Omit to hide the "View on the card" link. */
  onViewOnCard?: (callout: CustomerCallout) => void
}

export function ProofCalloutStrip({
  callouts,
  imageUrls,
  onViewOnCard,
  startCollapsed = false,
}: Props) {
  const [open, setOpen] = useState(!startCollapsed)

  if (callouts.length === 0) return null

  const label = calloutStripLabel(callouts)

  return (
    <div className="mt-4 overflow-hidden rounded-[10px] border border-brand-200 bg-brand-50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[14px] font-medium text-ink transition-colors hover:bg-brand-100 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600"
      >
        <MessageSquare size={16} aria-hidden="true" className="flex-none text-brand-700" />
        {/* The label already carries the count ("2 notes from Rob"), so the
            separate chip said two twice. */}
        <span>{label}</span>
        <span
          aria-hidden="true"
          className="ml-auto text-[15px] text-ink-mute transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        >
          ⌄
        </span>
      </button>

      {open && (
        <div className="border-t border-brand-200 bg-surface px-4 pb-3 pt-1">
          {callouts.map((c, i) => {
            const url = c.proof_version_image_id
              ? imageUrls[c.proof_version_image_id]
              : undefined

            return (
              <div
                key={c.id}
                className={`flex gap-3 py-3 ${i > 0 ? 'border-t border-line-soft' : ''}`}
              >
                {url ? (
                  <div
                    role="img"
                    aria-label="Detail of the area this note refers to"
                    className="h-[62px] w-[62px] flex-none rounded-[6px] border border-line"
                    style={cropStyle(url, c.x, c.y)}
                  />
                ) : (
                  <div className="grid h-[62px] w-[62px] flex-none place-items-center rounded-[6px] border border-line bg-canvas text-[11px] tabular-nums text-ink-mute">
                    {i + 1}
                  </div>
                )}

                <div className="min-w-0">
                  {c.author_name && (
                    <p className="mb-0.5 text-[11.5px] text-ink-mute">{c.author_name}</p>
                  )}
                  <p className="m-0 whitespace-pre-line text-[13.5px] text-ink-soft">{c.body}</p>
                  {onViewOnCard && (
                    <button
                      type="button"
                      onClick={() => onViewOnCard(c)}
                      className="mt-1 bg-transparent p-0 text-[12.5px] text-brand-700 underline decoration-1 underline-offset-2 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                      View on the card
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
