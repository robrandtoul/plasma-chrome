import { useEffect, useRef } from 'react'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import {
  PAPER_TINT_1,
  PAPER_INK,
  PAPER_SECONDARY,
  CTA_GHOST_BORDER,
  CTA_GHOST_TEXT,
  CTA_GHOST_BG,
  CTA_GHOST_HOVER_BG,
  CTA_GHOST_PRESSED_BG,
  CTA_GHOST_HOVER_BORDER,
  SERIF,
  SANS,
  MONO,
} from '../lib/theme'

const REG_A_BASE = {
  fontFamily: SANS,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
}

const REG_B_BASE = {
  fontFamily: SANS,
  letterSpacing: '-0.005em',
}

// Brand blue used by the request-changes family — same colour the
// modal header used before this panel landed (theme.ts deviation #9).
const BRAND_BLUE = '#3a2c91'

// Send-request CTA: solid brand-blue fill, white text. A small
// hover/pressed darken keeps the affordance consistent with the
// other paper-register buttons without inventing a new token.
const SEND_BG = BRAND_BLUE
const SEND_HOVER_BG = '#2f2476'
const SEND_PRESSED_BG = '#251c5b'
const SEND_RING = 'rgba(58,44,145,0.45)'

export type RequestChangesPanelProps = {
  // The same actionPanel state shape CustomerProofPage uses, narrowed
  // to the request_changes branch. roundVariant carries the variant-
  // round selection metadata when this panel was opened via
  // openVariantActionPanel — the labels swap to a "choose direction"
  // framing in that case.
  actionPanel: {
    versionId: string
    name: string
    type: 'request_changes'
    roundVariant?: { id: string; displayName: string } | null
  }
  actionName: string
  setActionName: (value: string) => void
  actionComment: string
  setActionComment: (value: string) => void
  actionError: string | null
  actionSubmitting: boolean
  // Optional intro copy resolved from publicSettings; passed in as a
  // string so the panel stays decoupled from settings loading.
  introCopy: string | null
  closeActionPanel: () => void
  submitAction: () => void
}

// Docked panel (desktop, right edge) / bottom sheet (mobile) host
// for the request-changes form. Phase 1 of the customer-page action
// rework — see CLAUDE.md.
//
// Deliberately non-modal: no dark backdrop, no body-scroll lock, no
// focus trap. The customer must be able to see and scroll the proof
// while typing their comment. The owning page is responsible for
// reflowing its content (desktop right-padding / mobile bottom-
// padding) so nothing is hidden behind the fixed panel.
export function RequestChangesPanel({
  actionPanel,
  actionName,
  setActionName,
  actionComment,
  setActionComment,
  actionError,
  actionSubmitting,
  introCopy,
  closeActionPanel,
  submitAction,
}: RequestChangesPanelProps) {
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  // Move focus to the first input on open. requestAnimationFrame
  // waits one frame so the panel DOM is mounted before we focus.
  // Mirrors the lightbox / modal focus pattern in CustomerProofPage
  // but without the Tab trap — the customer must be able to tab back
  // out into the proof page behind the panel.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      firstFieldRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Empty dep array: panel mounts when actionPanel becomes a
    // request_changes shape and unmounts when it doesn't, so a
    // single on-mount focus is correct.
  }, [])

  // Panel-scoped Escape handler. Independent of the modal's focus
  // trap effect (which only applies to the approve flow), so the
  // panel can listen here without double-binding. Suppressed while a
  // submit is in flight so the customer can't drop the in-flight
  // request.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!actionSubmitting) closeActionPanel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [actionSubmitting, closeActionPanel])

  const isVariantRound = !!actionPanel.roundVariant
  const isShared = actionPanel.name === SHARED_APPROVAL_KEY

  // Recipient line. For variant rounds this collapses to the chosen
  // direction name; for shared proofs (no per-recipient slot) it
  // collapses entirely so the eyebrow + helper copy carry the
  // context. Otherwise renders "For <Name>'s card".
  const recipientLine = isVariantRound
    ? actionPanel.roundVariant?.displayName ?? null
    : isShared
      ? null
      : `For ${actionPanel.name}'s card`

  const textareaLabel = isVariantRound
    ? 'Notes for the team (required)'
    : 'What changes do you need?'

  const sendButtonLabel = isVariantRound
    ? actionSubmitting ? 'Sending…' : 'Send selection'
    : actionSubmitting ? 'Sending…' : 'Send request'

  return (
    <>
      {/* Bottom-sheet (mobile) / side-dock (desktop) container.
          z-40 sits below the approve modal (z-50) and the lightbox
          (z-50) so those stay on top when both are open. */}
      <aside
        role="dialog"
        aria-label={
          isVariantRound
            ? `Choose this direction — ${actionPanel.roundVariant?.displayName ?? ''}`
            : 'Request changes'
        }
        className={[
          'fixed z-40 flex flex-col',
          // Mobile: bottom sheet, full width, rounded top corners.
          'inset-x-0 bottom-0 max-h-[70vh] w-full rounded-t-2xl',
          // Desktop (sm+): fixed to the right edge, full height, ~400px
          // wide, square corners against the viewport edge.
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:bottom-auto sm:top-0',
          'sm:h-[100dvh] sm:max-h-none sm:w-[400px] sm:rounded-none',
          // Subtle slide-in.
          'motion-safe:animate-[rcp-in_180ms_ease-out]',
        ].join(' ')}
        style={{
          background: PAPER_TINT_1,
          color: PAPER_INK,
          // Mobile: top hairline + soft shadow lifting the sheet
          // above the page. Desktop: a single left hairline; the
          // shadow is overridden below.
          borderTop: '1px solid rgba(26,22,18,0.18)',
          boxShadow: '0 -8px 32px rgba(0,0,0,0.15)',
        }}
      >
        {/* Desktop swaps the top hairline for a left hairline and
            drops the upward shadow in favour of a left-side one.
            Done in a child <style> so we don't need a Tailwind plugin
            for border-direction toggling. */}
        <style>{`
          @keyframes rcp-in {
            from { transform: translateY(16px); opacity: 0.6; }
            to   { transform: translateY(0);    opacity: 1; }
          }
          @media (min-width: 640px) {
            @keyframes rcp-in {
              from { transform: translateX(16px); opacity: 0.6; }
              to   { transform: translateX(0);    opacity: 1; }
            }
          }
        `}</style>

        {/* Mobile drag-handle bar — purely decorative; the panel
            is not actually drag-dismissable in Phase 1. Hidden on
            desktop. */}
        <div className="flex justify-center pt-3 sm:hidden" aria-hidden="true">
          <span
            className="block h-1 w-10 rounded-full"
            style={{ background: 'rgba(26,22,18,0.20)' }}
          />
        </div>

        {/* Header: eyebrow + recipient line + close button. */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
          <div>
            <p className="m-0" style={{ ...REG_A_BASE, fontSize: 11, color: BRAND_BLUE }}>
              {isVariantRound ? 'Choose this direction' : 'Request changes'}
            </p>
            {recipientLine && (
              <p
                className="mt-1 text-[15px] leading-[1.3]"
                style={{ fontFamily: SERIF, color: PAPER_INK }}
              >
                {recipientLine}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeActionPanel}
            disabled={actionSubmitting}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-[rgba(26,22,18,0.06)] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)]"
            style={{ color: 'rgba(26,22,18,0.55)' }}
          >
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>

        {/* Scrollable body. flex-1 + overflow-y-auto so the form
            scrolls internally on short viewports while the footer
            (Cancel + Send) stays pinned. */}
        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-4 sm:px-6">
          {!isVariantRound && introCopy && (
            <p
              className="max-w-[60ch] whitespace-pre-line text-[14px] leading-[1.6]"
              style={{ fontFamily: SERIF, color: PAPER_SECONDARY }}
            >
              {introCopy}
            </p>
          )}

          <div className="mt-5">
            <label className="block" style={{ ...REG_A_BASE, color: PAPER_INK }}>
              Your name <span style={{ color: BRAND_BLUE }}>*</span>
            </label>
            <input
              ref={firstFieldRef}
              type="text"
              value={actionName}
              onChange={(e) => setActionName(e.target.value)}
              disabled={actionSubmitting}
              className="mt-2 w-full rounded-md px-4 py-3 text-[17px] sm:text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)] placeholder:text-[rgba(26,22,18,0.45)]"
              style={{
                fontFamily: SANS,
                background: '#ffffff',
                border: '1px solid rgba(26,22,18,0.18)',
                color: PAPER_INK,
              }}
            />
          </div>

          <div className="mt-5">
            <label
              className="block"
              style={{
                ...REG_B_BASE,
                fontSize: 14,
                fontWeight: 500,
                color: PAPER_INK,
              }}
            >
              {isVariantRound
                ? <>Notes for the team <span style={{ color: BRAND_BLUE }}>(required)</span></>
                : <>What changes do you need? <span style={{ color: BRAND_BLUE }}>*</span></>}
            </label>
            <textarea
              value={actionComment}
              onChange={(e) => setActionComment(e.target.value)}
              disabled={actionSubmitting}
              rows={6}
              aria-label={textareaLabel}
              className="mt-2 w-full rounded-md px-4 py-3 text-[17px] sm:text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)] placeholder:text-[rgba(26,22,18,0.45)]"
              style={{
                fontFamily: SANS,
                background: '#ffffff',
                border: '1px solid rgba(26,22,18,0.18)',
                color: PAPER_INK,
              }}
            />
          </div>

          {actionError && (
            <p
              className="mt-4 max-w-[60ch] text-[14px] leading-[1.55]"
              style={{ fontFamily: SANS, color: BRAND_BLUE }}
            >
              {actionError}
            </p>
          )}
        </div>

        {/* Footer: Cancel + Send pinned to the bottom of the panel. */}
        <div
          className="flex items-center justify-end gap-3 px-5 py-4 sm:px-6 sm:py-5"
          style={{ borderTop: '1px solid rgba(26,22,18,0.10)' }}
        >
          <button
            type="button"
            onClick={closeActionPanel}
            disabled={actionSubmitting}
            onMouseEnter={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = CTA_GHOST_HOVER_BG
              e.currentTarget.style.borderColor = CTA_GHOST_HOVER_BORDER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = CTA_GHOST_BG
              e.currentTarget.style.borderColor = CTA_GHOST_BORDER
            }}
            onMouseDown={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = CTA_GHOST_PRESSED_BG
            }}
            onMouseUp={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = CTA_GHOST_HOVER_BG
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-5 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)]"
            style={{
              background: CTA_GHOST_BG,
              border: `1.5px solid ${CTA_GHOST_BORDER}`,
              color: CTA_GHOST_TEXT,
              fontFamily: MONO,
              fontSize: 13,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitAction}
            disabled={actionSubmitting}
            aria-label={
              isVariantRound
                ? `Send selection — ${actionPanel.roundVariant?.displayName ?? ''}`
                : 'Send change request'
            }
            onMouseEnter={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = SEND_HOVER_BG
            }}
            onMouseLeave={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = SEND_BG
            }}
            onMouseDown={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = SEND_PRESSED_BG
            }}
            onMouseUp={(e) => {
              if (actionSubmitting) return
              e.currentTarget.style.background = SEND_HOVER_BG
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-6 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2"
            style={{
              background: SEND_BG,
              border: 'none',
              color: '#ffffff',
              fontFamily: MONO,
              fontSize: 13,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              ['--tw-ring-color' as string]: SEND_RING,
            }}
          >
            {sendButtonLabel}
          </button>
        </div>
      </aside>
    </>
  )
}
