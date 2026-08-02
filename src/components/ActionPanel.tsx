import { useEffect, useRef } from 'react'
import { X, Check, Send } from 'lucide-react'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { ButtonInk, ButtonCoral, ButtonGhost, Pill } from '../design'
import { ProofPinPlacer } from './ProofPinPlacer'
import type { GridImage } from './ImageGrid'
import type { DraftPin } from '../lib/proofAnnotations'

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
    // Human label when `name` isn't display-friendly — set for Set
    // (collection) layouts, where `name` is a layout id and this carries
    // the layout title.
    displayName?: string
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
  // Earlier-version acknowledgement. True when the version being
  // approved is not the latest — approving a superseded design is
  // higher-risk than the standard disclaimer covers, so the panel
  // renders an extra warning block + tick at the top of the body
  // (above Your name) and gates Confirm on it. earlierVersionNumber
  // is the version being approved; latestVersionNumber is what the
  // warning copy points the customer at. Null on either when the
  // proof has no resolvable latest version — the panel still renders
  // the block but uses fallback copy. The tick is hidden entirely on
  // the request-changes and variant-round paths (gated on isApprove
  // in render and in the gate predicate).
  isEarlierVersion: boolean
  earlierVersionNumber: number | null
  latestVersionNumber: number | null
  actionEarlierVersionAcked: boolean
  setActionEarlierVersionAcked: (value: boolean) => void
  // Migration 000347 — optional "point at it" pins on a change request.
  // pinImages is empty when the gate (settings.proof_pins_enabled) is off, when
  // the slot has no usable artwork, or on the approve path — the placer renders
  // nothing in each case, so the panel is byte-identical to its previous shape.
  // Pins are never required: a change request with zero pins is complete, and
  // roughly a third of real ones are contact-data edits where pointing adds
  // nothing at all.
  pinImages?: GridImage[]
  draftPins?: DraftPin[]
  setDraftPins?: (next: DraftPin[]) => void
}

// Reusable checkbox-card row used by the three approve-only gates
// (earlier-version ack, disclaimer ack, QR-contents ack). Renders a
// label-wrapped sr-only checkbox + visible 20px tick + body copy,
// with focus-within ring on the wrapper so keyboard focus is
// visible (the real input is hidden). The wrapper border darkens
// when checked so the customer can see the state at a glance.
function CheckboxRow({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
  label: React.ReactNode
}) {
  return (
    <label
      className={[
        'mt-4 flex w-fit items-center gap-3 rounded-[10px] bg-surface px-4 py-3 transition-colors',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--c-brand)]',
        disabled ? 'cursor-wait' : 'cursor-pointer hover:border-ink-soft',
        checked ? 'border-[1.5px] border-ink' : 'border-[1.5px] border-line',
      ].join(' ')}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={[
          'grid h-5 w-5 shrink-0 place-items-center rounded-[4px]',
          checked
            ? 'bg-ink border-[1.5px] border-ink text-on-ink'
            : 'bg-canvas border-[1.5px] border-line',
        ].join(' ')}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="text-[14px] font-medium text-ink">{label}</span>
    </label>
  )
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
  isEarlierVersion,
  earlierVersionNumber,
  latestVersionNumber,
  actionEarlierVersionAcked,
  setActionEarlierVersionAcked,
  pinImages,
  draftPins,
  setDraftPins,
}: ActionPanelProps) {
  const isApprove = actionPanel.type === 'approve'
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
  // Display label for the slot. For a Set (collection) layout, `name` is
  // a layout id (UUID) and `displayName` carries the layout title; the
  // copy below branches on its presence so layouts read naturally
  // ("the ECG card layout") instead of with the per-person possessive.
  const isLayout = actionPanel.displayName != null
  const slotLabel = actionPanel.displayName ?? actionPanel.name

  // Recipient line. For variant rounds this collapses to the chosen
  // direction name; for shared proofs (no per-recipient slot) it
  // collapses entirely so the eyebrow + helper copy carry the
  // context. Layouts read "Layout: <title>". Otherwise "For <Name>'s card".
  const recipientLine = isVariantRound
    ? actionPanel.roundVariant?.displayName ?? null
    : isShared
      ? null
      : isLayout
        ? `Layout: ${slotLabel}`
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
        : isLayout
          ? `Approve the ${slotLabel} layout`
          : `Approve ${actionPanel.name}'s design`
      : 'Send change request'

  // Approve-only Confirm gating — disclaimer tick (when configured),
  // QR-confirmation tick (when the slot has any QRs), and the
  // earlier-version acknowledgement (when the version being
  // approved isn't the latest). Mirrors submitAction's server-side
  // guards so the button can't claim to be enabled while the submit
  // would refuse.
  const disclaimerGate = isApprove && !!disclaimerText && !actionDisclaimerAcked
  const qrGate = isApprove && slotQrCount > 0 && !actionQrConfirmed
  const earlierVersionGate =
    isApprove && isEarlierVersion && !actionEarlierVersionAcked
  const confirmDisabled =
    actionSubmitting || disclaimerGate || qrGate || earlierVersionGate

  // Approve dialog aria-label echoes the modal's wording so SR users
  // landing in the panel get the same "Approve <name>'s design"
  // context they had before.
  const dialogAriaLabel = isVariantRound
    ? `Choose this direction — ${actionPanel.roundVariant?.displayName ?? ''}`
    : isApprove
      ? isShared
        ? 'Approve this proof'
        : isLayout
          ? `Approve the ${slotLabel} layout`
          : `Approve ${actionPanel.name}'s design`
      : 'Request changes'

  // Approve uses ButtonCoral (the brand / teal fill) as the primary
  // "Confirm" CTA — the positive primary action carries the accent.
  // request-changes / variant-round use ButtonInk (dark fill) so the
  // panel's CTA mirrors the per-recipient action band on the overview
  // (Approve = brand, Request changes = ink). The previous Direction-B
  // brand-blue (#3a2c91) Send CTA is retired — it predated the design
  // system and no other surface uses that hue.
  const PrimaryCTA = isApprove ? ButtonCoral : ButtonInk

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
          'fixed z-40 flex flex-col bg-surface text-ink',
          // Mobile: bottom sheet, full width, rounded top corners,
          // top hairline + upward shadow lifting the sheet above the
          // page.
          'inset-x-0 bottom-0 h-[50vh] w-full rounded-t-[14px]',
          'border-t border-line shadow-[0_-8px_32px_rgba(22,19,17,0.12)]',
          // Desktop (sm+): fixed to the right edge, full height, ~400px
          // wide, square corners against the viewport edge, left
          // hairline + leftward shadow.
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:bottom-auto sm:top-0',
          'sm:h-[100dvh] sm:max-h-none sm:w-[400px] sm:rounded-none',
          'sm:border-t-0 sm:border-l sm:border-line sm:shadow-[-8px_0_32px_rgba(22,19,17,0.10)]',
          // Subtle slide-in.
          'motion-safe:animate-[rcp-in_180ms_ease-out]',
        ].join(' ')}
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
            is not actually drag-dismissable. Hidden on desktop. */}
        <div className="flex justify-center pt-3 sm:hidden" aria-hidden="true">
          <span className="block h-1 w-10 rounded-full bg-line" />
        </div>

        {/* Header: eyebrow + recipient line + close button. */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
          <div>
            <span className="eyebrow">{headerEyebrow}</span>
            {recipientLine && (
              <p className="mt-1 font-display text-[18px] leading-tight text-ink">
                {recipientLine}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeActionPanel}
            disabled={actionSubmitting}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-mute transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
          >
            <X size={16} aria-hidden="true" />
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
                className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand"
              >
                <Check size={22} strokeWidth={2.5} />
              </div>
              <p className="mt-5 max-w-[60ch] whitespace-pre-line text-[15px] leading-[1.6] text-ink sm:text-[16px]">
                {/* Admin-configured copy reads as the confirmation
                    of a request already made — exactly where it
                    belongs now. Generic fallback covers the case
                    where the admin hasn't set custom copy. */}
                {introCopy && introCopy.trim() !== ''
                  ? introCopy
                  : 'Thanks. Your change request has been sent.'}
              </p>
            </div>

            {/* Footer — single Done button, ink primary so it reads
                as the natural next action. */}
            <div className="flex items-center justify-end px-5 py-4 border-t border-line-soft sm:px-6 sm:py-5">
              <ButtonInk ref={doneButtonRef} onClick={closeActionPanel}>
                Done
              </ButtonInk>
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
            <div className="flex-1 overflow-y-auto px-5 pb-4 pt-4 sm:flex sm:flex-col sm:min-h-0 sm:px-6">
              {/* Approve-only earlier-version warning + tick. Renders
                  first in the body — the customer should see this
                  before reaching the name field, because it changes
                  the meaning of the whole action. Approving a
                  superseded design is supported but not the default
                  expectation; the low (amber) palette mirrors the
                  "Heads up" block on the overview's action band so
                  the customer reads the same visual register here.
                  The tick gates Confirm alongside the disclaimer
                  and QR ticks. */}
              {isApprove && isEarlierVersion && (
                <div className="mt-1 flex flex-col gap-3 rounded-[10px] bg-low-soft border border-low px-4 py-4">
                  <Pill colour="low">Not the current version</Pill>
                  <p className="text-[14px] leading-[1.55] text-ink">
                    {earlierVersionNumber != null && latestVersionNumber != null
                      ? `You are approving version ${earlierVersionNumber}. Version ${latestVersionNumber} is the current version.`
                      : 'You are approving a version other than the current one.'}
                  </p>
                  <CheckboxRow
                    checked={actionEarlierVersionAcked}
                    disabled={actionSubmitting}
                    onChange={setActionEarlierVersionAcked}
                    label={
                      earlierVersionNumber != null
                        ? `I understand I am approving version ${earlierVersionNumber}, not the current version`
                        : 'I understand I am approving a version other than the current one'
                    }
                  />
                </div>
              )}

              <div className={isApprove && isEarlierVersion ? 'mt-5' : 'mt-1'}>
                <label className="eyebrow block">
                  Your name <span className="text-brand">*</span>
                </label>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={actionName}
                  onChange={(e) => setActionName(e.target.value)}
                  disabled={actionSubmitting}
                  className="mt-2 w-full rounded-[8px] bg-surface border border-line text-ink px-3 py-3 text-[17px] sm:text-[15px] placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] transition-colors disabled:bg-canvas disabled:text-ink-mute disabled:cursor-not-allowed"
                />
              </div>

              {isApprove ? (
                <div className="mt-5">
                  <label className="eyebrow block">
                    Anything to add? <span className="text-ink-mute normal-case tracking-normal text-[12px]">(optional)</span>
                  </label>
                  <textarea
                    value={actionComment}
                    onChange={(e) => setActionComment(e.target.value)}
                    disabled={actionSubmitting}
                    rows={3}
                    aria-label={textareaLabel}
                    className="mt-2 w-full rounded-[8px] bg-surface border border-line text-ink p-3 text-[17px] sm:text-[15px] leading-[1.5] resize-y placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] transition-colors disabled:bg-canvas disabled:text-ink-mute disabled:cursor-not-allowed"
                  />
                </div>
              ) : (
                // Desktop (sm+): the wrapper and the textarea flex to
                // fill the remaining vertical space in the panel body
                // so the message box uses the full panel height rather
                // than its rows={6} content size. min-h-0 on every step
                // of the flex chain (body container, this wrapper, the
                // textarea) lets the textarea actually shrink and grow
                // by flex rather than by its rows attribute. On mobile
                // the rows={6} fixed height is kept — the 50vh sheet
                // has no spare room to give.
                <div className="mt-5 sm:flex sm:flex-1 sm:flex-col sm:min-h-0">
                  <label className="eyebrow block">
                    {isVariantRound
                      ? <>Notes for the team <span className="text-brand normal-case tracking-normal text-[12px]">(required)</span></>
                      : <>What changes do you need? <span className="text-brand">*</span></>}
                  </label>
                  <textarea
                    value={actionComment}
                    onChange={(e) => setActionComment(e.target.value)}
                    disabled={actionSubmitting}
                    rows={6}
                    aria-label={textareaLabel}
                    className="mt-2 w-full rounded-[8px] bg-surface border border-line text-ink p-3 text-[17px] sm:flex-1 sm:min-h-0 sm:text-[15px] leading-[1.5] resize-y placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] transition-colors disabled:bg-canvas disabled:text-ink-mute disabled:cursor-not-allowed"
                  />

                  {/* Optional pins (migration 000347). Sits UNDER the notes box
                      deliberately: the note is the primary, sufficient input and
                      must not be displaced by an embellishment. Renders nothing
                      when the gate is off or the slot has no artwork. */}
                  {pinImages && pinImages.length > 0 && setDraftPins && (
                    <div className="mt-4">
                      <label className="eyebrow block">
                        Point at it{' '}
                        <span className="text-ink-mute normal-case tracking-normal text-[12px]">
                          (optional)
                        </span>
                      </label>
                      <div className="mt-2">
                        <ProofPinPlacer
                          images={pinImages}
                          pins={draftPins ?? []}
                          setPins={setDraftPins}
                          disabled={actionSubmitting}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Approve-only disclaimer block. Lifted verbatim from
                  the previous modal so the customer-facing friction
                  (must tick to confirm) is unchanged — only the
                  container moves. The session-scoped flag collapses
                  the body to a one-liner after the first approve,
                  with a "Show disclaimer" affordance on subsequent
                  opens. */}
              {isApprove && disclaimerText && (
                <div className="mt-6">
                  <span className="eyebrow block">Disclaimer</span>
                  {disclaimerAckedThisSession && !actionDisclaimerExpanded ? (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <p className="text-[14px] leading-[1.6] text-ink-soft">
                        By confirming, you reaffirm you have read the disclaimer.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActionDisclaimerExpanded(true)}
                        className="eyebrow self-start text-ink hover:underline underline-offset-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]"
                      >
                        Show disclaimer
                      </button>
                    </div>
                  ) : (
                    <p
                      className="mt-2 max-w-[60ch] whitespace-pre-line rounded-[8px] bg-surface border border-line px-3 py-3 text-[13px] leading-[1.6] text-ink sm:px-4 sm:text-[14px] sm:leading-[1.65]"
                      style={{ overflowWrap: 'anywhere' }}
                    >
                      {disclaimerText}
                    </p>
                  )}
                  <CheckboxRow
                    checked={actionDisclaimerAcked}
                    disabled={actionSubmitting}
                    onChange={setActionDisclaimerAcked}
                    label="I confirm I have read the disclaimer above"
                  />
                </div>
              )}

              {/* Approve-only QR-confirmation tick (000169). Renders
                  only when the slot has at least one QR row visible
                  to it. Parent passes the count using the same
                  qrRowsForSlot predicate that submitAction's
                  server-mirror guard uses, so the tick + the
                  Confirm-disabled gate stay in lockstep. */}
              {isApprove && slotQrCount > 0 && (
                <div className="mt-6">
                  <span className="eyebrow block">QR code contents</span>
                  <p className="mt-2 max-w-[60ch] text-[13px] leading-[1.6] text-ink-soft sm:text-[14px] sm:leading-[1.65]">
                    {slotQrCount === 1
                      ? 'Please double-check the contents of the QR code shown above before approving.'
                      : `Please double-check the contents of the ${slotQrCount} QR codes shown above before approving.`}
                  </p>
                  <CheckboxRow
                    checked={actionQrConfirmed}
                    disabled={actionSubmitting}
                    onChange={setActionQrConfirmed}
                    label="I've verified my QR code contents"
                  />
                </div>
              )}

              {actionError && (
                <p className="mt-4 max-w-[60ch] text-[14px] leading-[1.55] text-out">
                  {actionError}
                </p>
              )}

              {/* Helper hints — only render when Confirm is gated
                  by a tick (not by submit-in-flight), so the
                  customer knows exactly what unlocks the action. */}
              {disclaimerGate && !actionSubmitting && (
                <p className="mt-3 text-[12px] text-ink-mute sm:text-[13px]">
                  Tick the disclaimer above to enable Confirm.
                </p>
              )}
              {qrGate && !actionSubmitting && (
                <p className="mt-2 text-[12px] text-ink-mute sm:text-[13px]">
                  Tick the QR code confirmation to enable Confirm.
                </p>
              )}
              {earlierVersionGate && !actionSubmitting && (
                <p className="mt-2 text-[12px] text-ink-mute sm:text-[13px]">
                  Tick the version acknowledgement to enable Confirm.
                </p>
              )}
            </div>

            {/* Footer: Cancel + primary CTA pinned to the bottom of
                the panel. Primary fill switches on the type — coral
                for request-changes / variant rounds, ink for approve.
                Approve also honours the disclaimer + QR +
                earlier-version gates (computed once at the top of
                the render). */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-soft sm:px-6 sm:py-5">
              <ButtonGhost onClick={closeActionPanel} disabled={actionSubmitting}>
                Cancel
              </ButtonGhost>
              <PrimaryCTA
                icon={isApprove ? Check : Send}
                onClick={submitAction}
                disabled={confirmDisabled}
                busy={actionSubmitting}
                aria-label={sendButtonAriaLabel}
              >
                {sendButtonLabel}
              </PrimaryCTA>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
