import { useEffect, useRef } from 'react'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import {
  PAPER_TINT_1,
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  CTA_GHOST_BORDER,
  CTA_GHOST_TEXT,
  CTA_GHOST_BG,
  CTA_GHOST_HOVER_BG,
  CTA_GHOST_PRESSED_BG,
  CTA_GHOST_HOVER_BORDER,
  CTA_TEAL,
  CTA_TEAL_HOVER,
  CTA_TEAL_PRESSED,
  CTA_TEAL_RING,
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

// Approve eyebrow ink — the same deep teal the previous approve
// modal used for its dialog-title kicker, so the visual register the
// customer associates with the approve flow carries across the
// modal → docked panel move.
const APPROVE_EYEBROW = '#1f5640'

export type ActionPanelProps = {
  // The same actionPanel state shape CustomerProofPage uses.
  // roundVariant carries the variant-round selection metadata when
  // this panel was opened via openVariantActionPanel — the labels
  // swap to a "choose direction" framing in that case. roundVariant
  // never co-occurs with type === 'approve' (variant rounds always
  // travel as request_changes server-side).
  actionPanel: {
    versionId: string
    name: string
    type: 'approve' | 'request_changes'
    roundVariant?: { id: string; displayName: string } | null
  }
  actionName: string
  setActionName: (value: string) => void
  actionComment: string
  setActionComment: (value: string) => void
  actionError: string | null
  actionSubmitting: boolean
  // Admin-configured confirmation copy resolved from publicSettings;
  // passed in as a string so the panel stays decoupled from settings
  // loading. Used only on the request_changes post-submit
  // confirmation view — it used to render as a pre-submit helper
  // paragraph, but the copy is worded as a confirmation of a request
  // already made and read wrong in that position. Approve never
  // renders a confirmation view, so this is unused on that path.
  introCopy: string | null
  closeActionPanel: () => void
  submitAction: () => void
  // True after the customer has successfully submitted a change
  // request. Swaps the form body and Cancel/Send footer for a
  // confirmation view (tick + the configured copy + a Done button).
  // Owned by CustomerProofPage, reset on close/open. Approve and
  // variant-round paths never set this flag — they close on success.
  submitted: boolean
  // ── Approve-only props ─────────────────────────────────────────
  // Disclaimer text resolved from publicSettings.disclaimer_text; null
  // when the admin hasn't configured one. The panel is the canonical
  // home for this copy on the approve path — the customer must tick
  // the acknowledgement before Confirm enables.
  disclaimerText: string | null
  // Whether the customer has acknowledged the disclaimer at least
  // once this page session. Collapses the disclaimer body to a
  // one-line reminder + "Show disclaimer" affordance on subsequent
  // approves so the customer isn't re-reading the same block every
  // time. The per-action tick still has to be set every time.
  disclaimerAckedThisSession: boolean
  actionDisclaimerAcked: boolean
  setActionDisclaimerAcked: (value: boolean) => void
  actionDisclaimerExpanded: boolean
  setActionDisclaimerExpanded: (value: boolean) => void
  // Migration 000169 — QR-confirmation tick. The panel renders the
  // tick when slotQrCount > 0 and gates Confirm on it. The parent
  // computes the count using the same qrRowsForSlot predicate that
  // submitAction's server-mirror guard uses, so panel + submit gate
  // stay in lockstep without the panel needing to know about the
  // GridImage shape.
  slotQrCount: number
  actionQrConfirmed: boolean
  setActionQrConfirmed: (value: boolean) => void
}

// Docked panel (desktop, right edge) / bottom sheet (mobile) host
// for both customer actions — request changes and approve. Replaces
// the previous dark-backdrop approve modal so the proof and the
// zoomed detail view stay visible while the customer reads the
// disclaimer and takes their final look (which is exactly the moment
// they need the proof in front of them).
//
// Deliberately non-modal for both flows: no dark backdrop, no body-
// scroll lock, no focus trap. The customer must be able to see and
// scroll the proof while typing their comment or reading the
// disclaimer. The owning page is responsible for reflowing its
// content (desktop right-padding / mobile bottom-padding) so nothing
// is hidden behind the fixed panel.
export function ActionPanel({
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
  submitted,
  disclaimerText,
  disclaimerAckedThisSession,
  actionDisclaimerAcked,
  setActionDisclaimerAcked,
  actionDisclaimerExpanded,
  setActionDisclaimerExpanded,
  slotQrCount,
  actionQrConfirmed,
  setActionQrConfirmed,
}: ActionPanelProps) {
  const isApprove = actionPanel.type === 'approve'
  // Accent ink for the header eyebrow and the brand-blue ring on the
  // request-changes flow. Approve switches to the teal register so
  // the customer reads the panel as the approve surface, not as a
  // recoloured request-changes form.
  const accentInk = isApprove ? APPROVE_EYEBROW : BRAND_BLUE
  const accentRing = isApprove ? CTA_TEAL_RING : SEND_RING
  const firstFieldRef = useRef<HTMLInputElement | null>(null)
  // Focused on transition to the confirmation view so a keyboard
  // user lands on Done and can dismiss with Enter.
  const doneButtonRef = useRef<HTMLButtonElement | null>(null)

  // Move focus to the first input on open. requestAnimationFrame
  // waits one frame so the panel DOM is mounted before we focus.
  // Mirrors the lightbox focus pattern in CustomerProofPage but
  // without a Tab trap — the customer must be able to tab back out
  // into the proof page behind the panel (which is the whole point
  // of moving the approve flow off the modal).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      firstFieldRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Empty dep array: panel mounts when actionPanel becomes non-
    // null and unmounts when it goes back to null, so a single
    // on-mount focus is correct for both flows.
  }, [])

  // Move focus to Done when the confirmation view appears so a
  // keyboard customer can dismiss with Enter. Only fires on the
  // false→true edge — depending on `submitted` is enough since
  // the panel doesn't flip back to false without unmounting
  // (closeActionPanel resets the flag and unmounts the panel).
  useEffect(() => {
    if (!submitted) return
    const frame = requestAnimationFrame(() => {
      doneButtonRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [submitted])

  // Panel-scoped Escape handler. Suppressed while a submit is in
  // flight so the customer can't drop the in-flight request.
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

  // Header eyebrow: "Choose this direction" / "Request changes" /
  // "Approve". Variant rounds always sit on the request_changes type
  // server-side, so this branches on isVariantRound first.
  const headerEyebrow = isVariantRound
    ? 'Choose this direction'
    : isApprove
      ? 'Approve'
      : 'Request changes'

  const textareaLabel = isVariantRound
    ? 'Notes for the team (required)'
    : isApprove
      ? 'Anything to add? (optional)'
      : 'What changes do you need?'

  // Primary CTA copy. Approve reads "Confirm" to match the prior
  // modal's verb; request-changes / variant-round keep their existing
  // "Send …" framing.
  const sendButtonLabel = actionSubmitting
    ? 'Sending…'
    : isVariantRound
      ? 'Send selection'
      : isApprove
        ? 'Confirm'
        : 'Send request'

  // Approve-confirm aria-label mirrors the prior modal's wording so
  // screen-reader users hear the explicit verb instead of inferring
  // it from the eyebrow.
  const sendButtonAriaLabel = isVariantRound
    ? `Send selection — ${actionPanel.roundVariant?.displayName ?? ''}`
    : isApprove
      ? isShared
        ? 'Approve this proof'
        : `Approve ${actionPanel.name}'s design`
      : 'Send change request'

  // Approve-only Confirm gating — disclaimer tick (when configured)
  // and QR-confirmation tick (when the slot has any QRs). Mirrors
  // submitAction's server-side guard so the button can't claim to be
  // enabled while the submit would refuse.
  const disclaimerGate = isApprove && !!disclaimerText && !actionDisclaimerAcked
  const qrGate = isApprove && slotQrCount > 0 && !actionQrConfirmed
  const confirmDisabled = actionSubmitting || disclaimerGate || qrGate

  // Approve dialog aria-label echoes the modal's wording so SR users
  // landing in the panel get the same "Approve <name>'s design"
  // context they had before.
  const dialogAriaLabel = isVariantRound
    ? `Choose this direction — ${actionPanel.roundVariant?.displayName ?? ''}`
    : isApprove
      ? isShared
        ? 'Approve this proof'
        : `Approve ${actionPanel.name}'s design`
      : 'Request changes'

  return (
    <>
      {/* Bottom-sheet (mobile) / side-dock (desktop) container.
          z-40 — there's no longer an approve modal stacked above
          (the approve flow now lives in this same panel); the
          lightbox stays at z-50 so it sits in front. */}
      <aside
        role="dialog"
        aria-label={dialogAriaLabel}
        className={[
          'fixed z-40 flex flex-col',
          // Mobile: bottom sheet, full width, rounded top corners,
          // top hairline + upward shadow lifting the sheet above the
          // page.
          'inset-x-0 bottom-0 h-[50vh] w-full rounded-t-2xl',
          'border-t border-t-[rgba(26,22,18,0.18)] shadow-[0_-8px_32px_rgba(0,0,0,0.15)]',
          // Desktop (sm+): fixed to the right edge, full height, ~400px
          // wide, square corners against the viewport edge, left
          // hairline + leftward shadow.
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:bottom-auto sm:top-0',
          'sm:h-[100dvh] sm:max-h-none sm:w-[400px] sm:rounded-none',
          'sm:border-t-0 sm:border-l sm:border-l-[rgba(26,22,18,0.18)] sm:shadow-[-8px_0_32px_rgba(0,0,0,0.12)]',
          // Subtle slide-in.
          'motion-safe:animate-[rcp-in_180ms_ease-out]',
        ].join(' ')}
        style={{
          background: PAPER_TINT_1,
          color: PAPER_INK,
        }}
      >
        {/* Subtle slide-in: translate-Y on mobile (up from below the
            viewport), translate-X on desktop (in from the right
            edge). Defined inline so the panel doesn't depend on a
            shared keyframe registered elsewhere. */}
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
            <p className="m-0" style={{ ...REG_A_BASE, fontSize: 11, color: accentInk }}>
              {headerEyebrow}
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
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-[rgba(26,22,18,0.06)] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2"
            style={{
              color: 'rgba(26,22,18,0.55)',
              ['--tw-ring-color' as string]: accentRing,
            }}
          >
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>

        {submitted ? (
          <>
            {/* Confirmation view. Swapped in by the parent when the
                standard request-changes path lands a successful
                submit. Header (eyebrow + recipient line + close ×)
                stays above this block; the form body + Cancel/Send
                footer is replaced by the tick + introCopy + Done.
                The variant-round path closes on success, so this
                branch never renders for "Choose this direction". */}
            <div className="flex-1 overflow-y-auto px-5 pb-4 pt-6 sm:px-6 sm:pt-8">
              <div
                aria-hidden="true"
                className="grid h-12 w-12 place-items-center rounded-full"
                style={{
                  background: 'rgba(58,44,145,0.12)',
                  color: BRAND_BLUE,
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12.5L10 17.5L19 7"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p
                className="mt-5 max-w-[60ch] whitespace-pre-line text-[15px] leading-[1.65] sm:text-[16px] sm:leading-[1.7]"
                style={{ fontFamily: SERIF, color: PAPER_INK }}
              >
                {/* Admin-configured copy reads as the confirmation
                    of a request already made — exactly where it
                    belongs now. Generic fallback covers the case
                    where the admin hasn't set custom copy. */}
                {introCopy && introCopy.trim() !== ''
                  ? introCopy
                  : 'Thanks. Your change request has been sent.'}
              </p>
            </div>

            {/* Footer — single Done button, primary brand-blue
                styling so it reads as the natural next action. */}
            <div
              className="flex items-center justify-end px-5 py-4 sm:px-6 sm:py-5"
              style={{ borderTop: '1px solid rgba(26,22,18,0.10)' }}
            >
              <button
                ref={doneButtonRef}
                type="button"
                onClick={closeActionPanel}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = SEND_HOVER_BG
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = SEND_BG
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.background = SEND_PRESSED_BG
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.background = SEND_HOVER_BG
                }}
                className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-6 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2"
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
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Scrollable body. flex-1 + overflow-y-auto so the form
                scrolls internally on short viewports while the footer
                (Cancel + Confirm/Send) stays pinned. Approve's
                disclaimer + QR blocks make this content notably
                longer than the request-changes form; the customer
                scrolls it inside the panel without the proof or
                detail view going anywhere. */}
            <div className="flex-1 overflow-y-auto px-5 pb-4 pt-4 sm:px-6">
              <div className="mt-1">
                <label className="block" style={{ ...REG_A_BASE, color: PAPER_INK }}>
                  Your name <span style={{ color: accentInk }}>*</span>
                </label>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={actionName}
                  onChange={(e) => setActionName(e.target.value)}
                  disabled={actionSubmitting}
                  className="mt-2 w-full rounded-md px-4 py-3 text-[17px] sm:text-[15px] outline-none transition-colors focus-visible:ring-2 placeholder:text-[rgba(26,22,18,0.45)]"
                  style={{
                    fontFamily: SANS,
                    background: '#ffffff',
                    border: '1px solid rgba(26,22,18,0.18)',
                    color: PAPER_INK,
                    ['--tw-ring-color' as string]: accentRing,
                  }}
                />
              </div>

              {isApprove ? (
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
                    Anything to add?{' '}
                    <span style={{ fontWeight: 400, color: PAPER_TERTIARY }}>
                      (optional)
                    </span>
                  </label>
                  <textarea
                    value={actionComment}
                    onChange={(e) => setActionComment(e.target.value)}
                    disabled={actionSubmitting}
                    rows={3}
                    aria-label={textareaLabel}
                    className="mt-2 w-full rounded-md px-4 py-3 text-[17px] sm:text-[15px] outline-none transition-colors focus-visible:ring-2 placeholder:text-[rgba(26,22,18,0.45)]"
                    style={{
                      fontFamily: SANS,
                      background: '#ffffff',
                      border: '1px solid rgba(26,22,18,0.18)',
                      color: PAPER_INK,
                      ['--tw-ring-color' as string]: accentRing,
                    }}
                  />
                </div>
              ) : (
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
                      ? <>Notes for the team <span style={{ color: accentInk }}>(required)</span></>
                      : <>What changes do you need? <span style={{ color: accentInk }}>*</span></>}
                  </label>
                  <textarea
                    value={actionComment}
                    onChange={(e) => setActionComment(e.target.value)}
                    disabled={actionSubmitting}
                    rows={6}
                    aria-label={textareaLabel}
                    className="mt-2 w-full rounded-md px-4 py-3 text-[17px] sm:text-[15px] outline-none transition-colors focus-visible:ring-2 placeholder:text-[rgba(26,22,18,0.45)]"
                    style={{
                      fontFamily: SANS,
                      background: '#ffffff',
                      border: '1px solid rgba(26,22,18,0.18)',
                      color: PAPER_INK,
                      ['--tw-ring-color' as string]: accentRing,
                    }}
                  />
                </div>
              )}

              {/* ── Approve-only disclaimer block ───────────────────
                  Lifted verbatim from the previous approve modal so
                  the customer-facing friction (must tick to confirm)
                  is unchanged — only the container moves. The
                  session-scoped flag still collapses the body to a
                  one-liner after the first approve, with a "Show
                  disclaimer" affordance on subsequent opens. */}
              {isApprove && disclaimerText && (
                <div className="mt-6">
                  <p style={{ ...REG_A_BASE, color: PAPER_INK }}>
                    Disclaimer
                  </p>
                  {disclaimerAckedThisSession && !actionDisclaimerExpanded ? (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <p
                        className="text-[14px] leading-[1.6]"
                        style={{ fontFamily: SANS, color: PAPER_SECONDARY }}
                      >
                        By confirming, you reaffirm you have read the disclaimer.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActionDisclaimerExpanded(true)}
                        className="self-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 rounded-sm"
                        style={{
                          ...REG_A_BASE,
                          color: PAPER_INK,
                          ['--tw-ring-color' as string]: accentRing,
                        }}
                      >
                        Show disclaimer
                      </button>
                    </div>
                  ) : (
                    <p
                      className="mt-2 max-w-[60ch] whitespace-pre-line rounded-md px-3 py-3 text-[13px] leading-[1.6] sm:px-4 sm:text-[14px] sm:leading-[1.65]"
                      style={{
                        fontFamily: SANS,
                        background: '#ffffff',
                        border: '0.5px solid rgba(26,22,18,0.18)',
                        color: PAPER_INK,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {disclaimerText}
                    </p>
                  )}
                  <label
                    className={[
                      'mt-4 flex w-fit items-center gap-3 rounded-lg px-4 py-3 transition-colors',
                      // The real <input> is sr-only so its focus
                      // ring is invisible; surface keyboard focus on
                      // the wrapping label so this control isn't a
                      // Focus Visible (WCAG 2.4.7) failure.
                      'focus-within:ring-2 focus-within:ring-offset-2',
                      actionSubmitting
                        ? 'cursor-wait'
                        : 'cursor-pointer hover:border-[rgba(26,22,18,0.6)]',
                    ].join(' ')}
                    style={{
                      border: actionDisclaimerAcked
                        ? `1.5px solid ${PAPER_INK}`
                        : '1.5px solid rgba(26,22,18,0.4)',
                      ['--tw-ring-color' as string]: accentRing,
                    }}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={actionDisclaimerAcked}
                      disabled={actionSubmitting}
                      onChange={(e) => setActionDisclaimerAcked(e.target.checked)}
                    />
                    <span
                      aria-hidden
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px]"
                      style={
                        actionDisclaimerAcked
                          ? {
                              background: PAPER_INK,
                              border: `1.5px solid ${PAPER_INK}`,
                            }
                          : {
                              background: 'transparent',
                              border: '1.5px solid rgba(26,22,18,0.4)',
                            }
                      }
                    >
                      {actionDisclaimerAcked && (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2.5 6.5L5 9L9.5 3.5"
                            stroke="#ffffff"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span
                      style={{
                        ...REG_B_BASE,
                        fontSize: 14,
                        fontWeight: 500,
                        color: PAPER_INK,
                      }}
                    >
                      I confirm I have read the disclaimer above
                    </span>
                  </label>
                </div>
              )}

              {/* ── Approve-only QR-confirmation tick (000169) ──────
                  Renders only when the slot has at least one QR row
                  visible to it. Parent passes the count using the
                  same qrRowsForSlot predicate that submitAction's
                  server-mirror guard uses, so the tick + the
                  Confirm-disabled gate stay in lockstep. */}
              {isApprove && slotQrCount > 0 && (
                <div className="mt-6">
                  <p style={{ ...REG_A_BASE, color: PAPER_INK }}>
                    QR code contents
                  </p>
                  <p
                    className="mt-2 max-w-[60ch] text-[13px] leading-[1.6] sm:text-[14px] sm:leading-[1.65]"
                    style={{ fontFamily: SANS, color: PAPER_SECONDARY }}
                  >
                    {slotQrCount === 1
                      ? 'Please double-check the contents of the QR code shown above before approving.'
                      : `Please double-check the contents of the ${slotQrCount} QR codes shown above before approving.`}
                  </p>
                  <label
                    className={[
                      'mt-4 flex w-fit items-center gap-3 rounded-lg px-4 py-3 transition-colors',
                      'focus-within:ring-2 focus-within:ring-offset-2',
                      actionSubmitting
                        ? 'cursor-wait'
                        : 'cursor-pointer hover:border-[rgba(26,22,18,0.6)]',
                    ].join(' ')}
                    style={{
                      border: actionQrConfirmed
                        ? `1.5px solid ${PAPER_INK}`
                        : '1.5px solid rgba(26,22,18,0.4)',
                      ['--tw-ring-color' as string]: accentRing,
                    }}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={actionQrConfirmed}
                      disabled={actionSubmitting}
                      onChange={(e) => setActionQrConfirmed(e.target.checked)}
                    />
                    <span
                      aria-hidden
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px]"
                      style={
                        actionQrConfirmed
                          ? {
                              background: PAPER_INK,
                              border: `1.5px solid ${PAPER_INK}`,
                            }
                          : {
                              background: 'transparent',
                              border: '1.5px solid rgba(26,22,18,0.4)',
                            }
                      }
                    >
                      {actionQrConfirmed && (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2.5 6.5L5 9L9.5 3.5"
                            stroke="#ffffff"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span
                      style={{
                        ...REG_B_BASE,
                        fontSize: 14,
                        fontWeight: 500,
                        color: PAPER_INK,
                      }}
                    >
                      I've verified my QR code contents
                    </span>
                  </label>
                </div>
              )}

              {actionError && (
                <p
                  className="mt-4 max-w-[60ch] text-[14px] leading-[1.55]"
                  style={{ fontFamily: SANS, color: accentInk }}
                >
                  {actionError}
                </p>
              )}

              {/* Helper hints — only render when Confirm is gated
                  by a tick (not by submit-in-flight), so the
                  customer knows exactly what unlocks the action.
                  Same tone as the rest of the body copy; sits
                  below the form fields so it reads as a footnote
                  rather than a primary instruction. */}
              {disclaimerGate && !actionSubmitting && (
                <p
                  className="mt-3 text-[12px] sm:text-[13px]"
                  style={{ fontFamily: SANS, color: 'rgba(26,22,18,0.65)' }}
                >
                  Tick the disclaimer above to enable Confirm.
                </p>
              )}
              {qrGate && !actionSubmitting && (
                <p
                  className="mt-2 text-[12px] sm:text-[13px]"
                  style={{ fontFamily: SANS, color: 'rgba(26,22,18,0.65)' }}
                >
                  Tick the QR code confirmation to enable Confirm.
                </p>
              )}
            </div>

            {/* Footer: Cancel + primary CTA pinned to the bottom of
                the panel. Primary fill switches on the type — brand
                blue for request-changes / variant rounds, teal for
                approve. Approve also honours the disclaimer + QR
                gates (computed once at the top of the render). */}
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
                className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-5 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2"
                style={{
                  background: CTA_GHOST_BG,
                  border: `1.5px solid ${CTA_GHOST_BORDER}`,
                  color: CTA_GHOST_TEXT,
                  fontFamily: MONO,
                  fontSize: 13,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  ['--tw-ring-color' as string]: accentRing,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAction}
                disabled={confirmDisabled}
                aria-label={sendButtonAriaLabel}
                onMouseEnter={(e) => {
                  if (confirmDisabled) return
                  e.currentTarget.style.background = isApprove ? CTA_TEAL_HOVER : SEND_HOVER_BG
                }}
                onMouseLeave={(e) => {
                  if (confirmDisabled) return
                  e.currentTarget.style.background = isApprove ? CTA_TEAL : SEND_BG
                }}
                onMouseDown={(e) => {
                  if (confirmDisabled) return
                  e.currentTarget.style.background = isApprove ? CTA_TEAL_PRESSED : SEND_PRESSED_BG
                }}
                onMouseUp={(e) => {
                  if (confirmDisabled) return
                  e.currentTarget.style.background = isApprove ? CTA_TEAL_HOVER : SEND_HOVER_BG
                }}
                className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-6 py-3 transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2"
                style={{
                  // Disabled state on approve renders as a ghost
                  // outline matching Cancel rather than a faded
                  // primary fill — matches the previous modal's
                  // treatment so the dimmed-teal-still-looks-clickable
                  // problem doesn't reappear. The disabled state
                  // never fires on request_changes (no gates beyond
                  // submit-in-flight), so the simple SEND_BG fill +
                  // opacity-60 path is preserved there.
                  background: confirmDisabled
                    ? isApprove
                      ? 'transparent'
                      : SEND_BG
                    : isApprove
                      ? CTA_TEAL
                      : SEND_BG,
                  border: confirmDisabled && isApprove
                    ? '1.5px solid rgba(26,22,18,0.20)'
                    : 'none',
                  color: confirmDisabled && isApprove
                    ? 'rgba(26,22,18,0.35)'
                    : '#ffffff',
                  opacity: confirmDisabled && !isApprove ? 0.6 : 1,
                  fontFamily: MONO,
                  fontSize: 13,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  ['--tw-ring-color' as string]: accentRing,
                }}
              >
                {sendButtonLabel}
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
