// Designer preview gate. Slots between Save and Send on the new-
// version flow (and between Save and the project page on edit-
// version) so the designer can't fall into the habit of saving and
// firing the Help Scout reply without ever looking at what the
// customer is about to see. Before this gate existed, the temptation
// was "create the version, click Send, move on" — and the first
// person to spot a layout error was the customer.
//
// Shape: a sticky banner at the top with version label, currency,
// and the two action buttons (Looks good → onConfirm; Go back and
// edit → onEdit), plus an iframe filling the rest of the viewport
// that points at /p/:id?preview=1&v=:versionId.
//
// Rendering the customer page inside an iframe (rather than
// importing the components directly) means the preview cannot
// drift from reality — it's the same route, the same data path
// (public_get_customer_proof RPC), the same lightbox behaviour the
// customer will see. The ?preview=1 flag suppresses view-recording
// on the customer side (see lib/customerProofUrl.ts and
// CustomerProofPage's record_proof_view bypass). The ?v= param
// pins the iframe to the specific just-saved version, important
// because designers can edit non-current versions (Set as current
// in VersionDetailModal) and the customer page defaults to
// whichever version carries is_current.
//
// State is deliberately ephemeral (callbacks only, no preview-
// approved column on proof_versions). This is a flow step that
// slows the designer down by one deliberate click, not an
// internal QA state worth modelling — persisting would muddy the
// meaning when edits, reopens, or carry-forwards happen later.

import { customerProofPath } from '../lib/customerProofUrl'
import type { Currency } from '../lib/types'

export interface VersionPreviewGateProps {
  proofId: string
  versionId: string
  versionNumber: number
  currency: Currency | null
  // Confirm advances to the next step in the parent flow. On
  // NewVersionPage that's the MessageSendPanel; on EditVersionPage
  // it's a navigate back to the project detail.
  onConfirm: () => void
  // Edit returns the designer to the edit-version form for the
  // just-saved version so they can fix what they spotted.
  onEdit: () => void
  // Label for the confirm button — copy differs by flow.
  // NewVersionPage: "Looks good, continue to send"
  // EditVersionPage: "Looks good, return to project"
  confirmLabel: string
}

export default function VersionPreviewGate({
  proofId,
  versionId,
  versionNumber,
  currency,
  onConfirm,
  onEdit,
  confirmLabel,
}: VersionPreviewGateProps) {
  // Build the iframe URL. ?preview=1 keeps the designer's hits out
  // of the customer-view audit ledger; ?v= pins to the specific
  // version the designer just saved.
  const previewSrc = `${customerProofPath(proofId)}?preview=1&v=${versionId}`

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface">
      {/* Sticky banner — gray-900 so it's unambiguously app chrome,
          not part of the customer page rendered below. Two-row
          layout on narrow viewports collapses cleanly. */}
      <div className="border-b border-ink bg-ink px-4 py-3 text-on-ink sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-low" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" />
                <path strokeLinecap="round" d="M8 5v3.5l2 1.5" />
              </svg>
              <span className="text-sm font-semibold">Preview, what the customer will see</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-ink-dim">
              <span>Version v{versionNumber}</span>
              {currency && (
                <>
                  <span aria-hidden="true" className="text-ink-soft">·</span>
                  <span>Currency {currency}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="rounded px-3 py-2 text-sm font-medium text-ink-dim ring-1 ring-ink hover:bg-ink hover:text-on-ink"
            >
              Go back and edit
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-in-stock px-4 py-2 text-sm font-semibold text-on-ink shadow-sm hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-in-stock"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>

      {/* The iframe carries the actual customer page. flex-1 makes
          it fill the remaining viewport height; the parent uses
          fixed-inset so the iframe always has a fixed sizing
          context regardless of how tall the underlying page is.
          title is required for a11y; sandbox is deliberately wide
          (same-origin needed for the customer page's Supabase
          calls to use the existing anon session and for its
          lightbox/scroll behaviour to work). */}
      <iframe
        src={previewSrc}
        title={`Preview of version v${versionNumber} as the customer will see it`}
        className="flex-1 w-full border-0 bg-surface"
      />
    </div>
  )
}
