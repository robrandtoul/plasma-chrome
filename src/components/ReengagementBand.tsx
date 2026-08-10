import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { ButtonInk } from '../design'
import {
  REENGAGEMENT_COPY,
  changeHelp,
  historyLine,
  recognitionLine,
  reorderNotePrefill,
  reorderQuantityPrefill,
  type ReengagementContext,
  type ReorderRequestKind,
} from '../lib/reengagement'
import type { ReorderState } from './ReorderPanel'

// The welcome band for a past customer the Reorder desk brought back
// (000389 / 000392). See src/lib/reengagement.ts for why this page needs a
// different opening than the standard proof: this customer did not ask for a
// proof, and the artwork is their own card rather than new work to judge.
//
// Two jobs: say when we last made their cards (recognition anchors memory and
// proves we're their actual supplier, not a stranger), then collect the one
// sentence the whole outreach exists for — "yes, N of these please".
//
// ⚠ WHY THIS IS NOT APPROVE / REQUEST CHANGES. The band shipped pointing both
// of its actions at the page's own approval controls, which was wrong twice
// over. Semantically, Approve means "I sign this off for print" — and the
// artwork is the one thing NOT in question here; they approved it years ago.
// Mechanically it is worse: a press marks the register row "Ordered again"
// with no order in existence and drops the customer out of every follow-up
// bucket for good (see suppressApproveForOutreach). What is actually open on
// this page is commercial, so it routes into the reorder-request mechanism
// (000372) — which means exactly that, and which by design can request but
// never buy.
//
// Deliberately NOT here: urgency, scarcity, countdowns, prices in the copy. We
// initiated this conversation, so pressure reads as spam and spends a
// relationship that took years to build. The price grid is already on the page
// with their own last quantity marked on it.

interface Props {
  context: ReengagementContext
  /** Whether the current version carries QR artwork — adds the one thing a
   *  customer can't verify by squinting at the card in their hand. */
  hasQrCodes: boolean
  /** The material on screen. The remembered purchase is only spoken when it
   *  describes THIS artwork — see specMatchesMaterial. */
  materialDisplay?: string | null
  // NOTE: there is deliberately no `approvalsEnabled` prop. When the site-wide
  // approvals kill switch is off the page passes no handlers and the whole
  // actions block below disappears — the band can't offer a route it hasn't
  // been given without a flag to tell it so.
  /** Submit the reorder request. ONE call for both openings; `kind` shapes the
   *  prompt and the first line the designer reads, never the mechanism. */
  onRequestReorder?: (input: {
    kind: ReorderRequestKind
    quantity: number | null
    note: string
  }) => void
  /** In-session state of that submission. */
  state?: ReorderState
  /** True once the SERVER says a request is already on file for this proof.
   *  Survives a reload and is visible to a colleague on the shared link, which
   *  in-session state can't be — see the 000392-shaped hoist in
   *  public_get_proof_order_state that makes this reachable at all. */
  alreadyRequested?: boolean
  /** Open the existing "not ready to approve" panel. */
  onNotRightNow?: () => void
}

// One pressable opening. Borrows the checkout's finish-choice idiom so "this
// is a thing you can press" needs no explaining. Both carry the accent: they
// are peers, and the choice between them is about what you need, not about
// which we'd prefer.
function OpeningTile({
  title,
  help,
  onClick,
}: {
  title: string
  help: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-1 rounded-xl border border-line bg-surface p-4 text-left transition-colors',
        'hover:border-[var(--c-brand)] hover:bg-canvas',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]',
      ].join(' ')}
    >
      <span className="block text-sm font-semibold text-brand">{title}</span>
      <span className="mt-1 block text-[13px] leading-[1.5] text-ink-soft">{help}</span>
    </button>
  )
}

export default function ReengagementBand({
  context,
  hasQrCodes,
  materialDisplay,
  onRequestReorder,
  state = 'idle',
  alreadyRequested = false,
  onNotRightNow,
}: Props) {
  const history = historyLine(context)

  // null = the two openings are showing; a kind = its form is open.
  const [openKind, setOpenKind] = useState<ReorderRequestKind | null>(null)
  const [quantity, setQuantity] = useState(() => reorderQuantityPrefill(context))
  const [note, setNote] = useState('')
  // Honeypot. Hidden from people, tempting to simple bots; a filled value is
  // accepted and silently dropped. Same shape as ReorderPanel's.
  const [website, setWebsite] = useState('')
  const noteRef = useRef<HTMLTextAreaElement | null>(null)

  const busy = state === 'sending'
  // Server first, session second. A reload, a second tab, or a colleague on
  // the shared link all land on the server's answer; the session flag only
  // covers the moment between the POST and the next read.
  const acknowledged = alreadyRequested || state === 'sent' || state === 'throttled'

  function open(kind: ReorderRequestKind) {
    setOpenKind(kind)
    setNote(reorderNotePrefill(kind))
  }

  // Put the cursor after the prefilled sentence, so the new-joiner path starts
  // where the customer has to type rather than making them find the end of a
  // paragraph we wrote. Only when a prefill exists — stealing focus from an
  // empty box on a phone raises the keyboard over the artwork for no reason.
  //
  // preventScroll because the form replaces a button the customer just pressed,
  // so it is already under their eye; letting focus scroll it into view jumps
  // the page past the quantity field and off the top of the band.
  useEffect(() => {
    if (openKind !== 'new_person') return
    const el = noteRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [openKind])

  const canAct = !!onRequestReorder

  return (
    <section
      aria-labelledby="reengage-heading"
      // No bottom margin: the band is a flex child of the page's right column,
      // whose gap owns the spacing.
      className="overflow-hidden rounded-[14px] border border-line bg-surface"
    >
      <div className="px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
          {REENGAGEMENT_COPY.eyebrow}
        </p>
        <h2
          id="reengage-heading"
          className="mt-1 font-display text-[20px] font-medium leading-tight tracking-[-0.01em] text-ink sm:text-[22px]"
        >
          {REENGAGEMENT_COPY.heading}
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm text-ink-soft">
          {recognitionLine(context, { materialDisplay })}
        </p>
        <p className="mt-1 max-w-[62ch] text-sm text-ink-soft">{REENGAGEMENT_COPY.intro}</p>
        {history && <p className="mt-2 text-[13px] text-ink-mute">{history}</p>}
      </div>

      {canAct && (
        <div className="border-t border-line-soft px-5 py-4 sm:px-6 sm:py-5">
          {acknowledged ? (
            // Replaces the openings in place. ⚠ Never re-arm below this: a
            // customer we cold-approached, who did the thing we asked, and is
            // then shown the same ask again reads it as "they ignored me" —
            // the worst outcome available to a re-engagement page.
            <p className="max-w-[62ch] text-sm text-ink" data-reengage-ack role="status">
              {alreadyRequested && state !== 'sent'
                ? REENGAGEMENT_COPY.already
                : REENGAGEMENT_COPY.sent}
            </p>
          ) : openKind === null ? (
            <>
              {/* Wraps rather than crushing: two tiles plus the exit don't fit
                  one row on a narrow desktop or a tablet. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <OpeningTile
                  title={REENGAGEMENT_COPY.repeatAction}
                  help={REENGAGEMENT_COPY.repeatHelp}
                  onClick={() => open('repeat')}
                />
                <OpeningTile
                  title={REENGAGEMENT_COPY.newPersonAction}
                  help={REENGAGEMENT_COPY.newPersonHelp}
                  onClick={() => open('new_person')}
                />
              </div>
              {onNotRightNow && (
                // Subordinate by design. As a third equal-weight box it sat
                // beside the buying actions and invited the visitor to take
                // it, on a page whose visitor is low-intent by construction.
                <p className="mt-3 text-[13px] text-ink-mute">
                  <button
                    type="button"
                    onClick={onNotRightNow}
                    className="underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]"
                  >
                    {REENGAGEMENT_COPY.declineAction}
                  </button>
                </p>
              )}
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (busy || !onRequestReorder) return
                if (website.trim() !== '') return
                const n = Number(quantity.replace(/[^\d]/g, ''))
                onRequestReorder({
                  kind: openKind,
                  quantity: Number.isFinite(n) && n > 0 ? n : null,
                  note: note.trim(),
                })
              }}
            >
              <p className="text-sm font-semibold text-ink">{REENGAGEMENT_COPY.formHeading}</p>

              <label
                htmlFor="reengage-quantity"
                className="mt-3 block text-[13px] font-medium text-ink"
              >
                {REENGAGEMENT_COPY.quantityLabel}
              </label>
              <input
                id="reengage-quantity"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={busy}
                className="mt-1.5 w-full max-w-[160px] rounded-[8px] border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)] disabled:bg-canvas disabled:text-ink-mute"
              />
              <p className="mt-1.5 text-[13px] text-ink-mute">{REENGAGEMENT_COPY.quantityHint}</p>

              <label
                htmlFor="reengage-note"
                className="mt-4 block text-[13px] font-medium text-ink"
              >
                {REENGAGEMENT_COPY.noteLabel}
              </label>
              <textarea
                id="reengage-note"
                ref={noteRef}
                rows={openKind === 'new_person' ? 4 : 3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
                className="mt-1.5 w-full resize-y rounded-[8px] border border-line bg-surface p-3 text-sm leading-[1.5] text-ink transition-colors focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)] disabled:bg-canvas disabled:text-ink-mute"
              />
              <p className="mt-1.5 max-w-[62ch] text-[13px] text-ink-mute">
                {changeHelp({ hasQrCodes })}
              </p>

              {/* Honeypot — hidden from people, not from bots. */}
              <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden">
                <label htmlFor="reengage-website">Website</label>
                <input
                  id="reengage-website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <ButtonInk type="submit" icon={Send} busy={busy}>
                  {busy ? REENGAGEMENT_COPY.sending : REENGAGEMENT_COPY.submit}
                </ButtonInk>
                <button
                  type="button"
                  onClick={() => setOpenKind(null)}
                  disabled={busy}
                  className="text-[13px] text-ink-mute underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] disabled:opacity-50"
                >
                  {REENGAGEMENT_COPY.back}
                </button>
              </div>

              {state === 'error' && (
                <p className="mt-3 text-[13px] text-out" role="status">
                  {REENGAGEMENT_COPY.error}
                </p>
              )}

              <p className="mt-4 max-w-[62ch] text-[13px] text-ink-mute">
                {REENGAGEMENT_COPY.reassurance}
              </p>
            </form>
          )}
        </div>
      )}
    </section>
  )
}
