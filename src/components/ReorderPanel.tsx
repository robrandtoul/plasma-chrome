import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Send } from 'lucide-react'
import { ButtonInk } from '../design'
import { REORDER_COPY, REORDER_FORWARD_COPY, type ReorderForwardLink } from '../lib/proofOrderState'
import { customerProofPath } from '../lib/customerProofUrl'

// The "Need more?" panel on /p/:id (migration 000372).
//
// Shown once the customer's order has been with them long enough (the quiet
// window in _reorder_quiet_period_passed) so they've had a chance to compare
// the cards against the proof before being asked to buy more.
//
// It asks two questions and nothing else. Quantity is the only thing that
// reliably changes between orders; the note is optional and exists so the
// designer knows whether this needs a fresh proof round or can go straight to
// a reorder. Everything else — spec, price, delivery — is settled the way it
// always is, by a person.
//
// ⚠ This raises a REQUEST. It never takes money, never carries a link, and
// never claims one has been sent. See the header of
// supabase/functions/request-reorder for why /p/:id must not be able to
// transact.

// 'throttled' is the re-engagement band's case only: on an outreach proof there
// is no paid order to enumerate, so the server may answer a repeat submission
// honestly ("you've already told us") instead of the uniform ok the ordinary
// path returns to avoid being an oracle. Handled here too so a state this panel
// can never receive still reads as acknowledged rather than re-arming the form.
export type ReorderState = 'idle' | 'sending' | 'sent' | 'throttled' | 'error'

export interface ReorderPanelProps {
  state: ReorderState
  /** True once a request has landed recently — collapses the panel to its acknowledgement. */
  alreadyRequested: boolean
  onSubmit: (input: { quantity: number | null; note: string }) => void
}

export function ReorderPanel({ state, alreadyRequested, onSubmit }: ReorderPanelProps) {
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  // Honeypot. Hidden from people, tempting to simple bots; a filled value is
  // accepted and silently dropped server-side. Same shape as the closed-proof
  // contact form.
  const [website, setWebsite] = useState('')

  const acknowledged = state === 'sent' || state === 'throttled' || alreadyRequested
  const busy = state === 'sending'

  // Which acknowledgement is honest here. The fork the customer cares about —
  // payment link, or a fresh proof first — is decided by whether they told us
  // something changed, so the wording follows the note.
  //
  // ⚠ `alreadyRequested` (a reload inside the 24-hour window) is checked
  // FIRST and always gets the neutral one. The note lives in component state,
  // so after a reload it is empty even for someone who wrote a paragraph —
  // reading it there would confidently promise a payment link to exactly the
  // customer whose change means there isn't one coming. The server knows, but
  // does not expose it, and a migration to say slightly more on a reload is
  // not worth it. Saying less is free and always true.
  const acknowledgement = alreadyRequested
    ? REORDER_COPY.sent
    : note.trim()
      ? REORDER_COPY.sentWithNote
      : REORDER_COPY.sentPaymentLink

  return (
    <section
      className="rounded-[14px] border border-line bg-surface p-5 sm:p-6"
      aria-labelledby="reorder-panel-heading"
    >
      <span className="eyebrow" style={{ letterSpacing: '0.28em' }}>
        {REORDER_COPY.eyebrow}
      </span>
      <h2 id="reorder-panel-heading" className="h3 mt-2">
        {REORDER_COPY.heading}
      </h2>

      {acknowledged ? (
        <p className="body-soft mt-3" style={{ fontSize: 15 }}>
          {acknowledgement}
        </p>
      ) : (
        <>
          <p className="body-soft mt-2" style={{ fontSize: 15 }}>
            {REORDER_COPY.body}
          </p>

          <form
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault()
              if (busy) return
              if (website.trim() !== '') return
              const n = Number(quantity.replace(/[^\d]/g, ''))
              onSubmit({
                quantity: Number.isFinite(n) && n > 0 ? n : null,
                note: note.trim(),
              })
            }}
          >
            <label
              htmlFor="reorder-quantity"
              className="block text-[13px] font-medium text-ink"
            >
              {REORDER_COPY.quantityLabel}
            </label>
            <input
              id="reorder-quantity"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy}
              placeholder={REORDER_COPY.quantityPlaceholder}
              className="mt-1.5 w-full max-w-[220px] rounded-[8px] border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)] disabled:bg-canvas disabled:text-ink-mute"
            />

            <label
              htmlFor="reorder-note"
              className="mt-4 block text-[13px] font-medium text-ink"
            >
              {REORDER_COPY.noteLabel}
            </label>
            <textarea
              id="reorder-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder={REORDER_COPY.notePlaceholder}
              className="mt-1.5 w-full resize-y rounded-[8px] border border-line bg-surface p-3 text-sm leading-[1.5] text-ink transition-colors focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)] disabled:bg-canvas disabled:text-ink-mute"
            />
            <p className="mt-1.5 text-[13px] text-ink-mute">{REORDER_COPY.noteHint}</p>

            {/* Honeypot — hidden from people, not from bots. */}
            <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden">
              <label htmlFor="reorder-website">Website</label>
              <input
                id="reorder-website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>

            {/* The design-system button, not a hand-rolled one. This panel
                shipped with its own — 8px corners, semibold, no icon — which
                read as almost-but-not-quite next to the Approve /
                Request-changes pair the customer has already used on this
                page. ButtonInk is that exact control.

                Ink rather than coral for the same reason ActionPanel gives:
                the teal fill is the page's positive primary (Approve), and
                this is mechanically the same act as "Request changes" — fill
                a short form, it reaches us, we reply. Same variant, same
                Send icon. */}
            <ButtonInk type="submit" icon={Send} busy={busy} className="mt-4">
              {busy ? REORDER_COPY.sending : REORDER_COPY.action}
            </ButtonInk>

            {state === 'error' && (
              <p className="mt-3 text-[13px] text-out" role="status">
                {REORDER_COPY.error}
              </p>
            )}
          </form>
        </>
      )}
    </section>
  )
}

// ── The forward link (000374) ───────────────────────────────────────────────
//
// Shown INSTEAD of the panel above once the reorder project exists, which is
// why they share a file: they occupy the same slot and are mutually exclusive
// by construction (canRequestReorder returns false as soon as there's a link).
//
// This is what stops the bookmark going stale. The customer proof page is the
// URL people keep, and after 000371 it is also where they check on a delivery
// — so without this, someone returning a year later reads an accurate but
// useless account of an order that has already been superseded.
//
// ⚠ Says nothing about where the reorder has GOT to. The destination page
// answers that itself, and guessing at it from here would be a second, staler
// voice on the same question.
export function ReorderForwardPanel({ link }: { link: ReorderForwardLink }) {
  const when = link.requestedAt ? Date.parse(link.requestedAt) : NaN
  const dated = !Number.isNaN(when)

  return (
    <section
      className="rounded-[14px] border border-line bg-surface p-5 sm:p-6"
      aria-labelledby="reorder-forward-heading"
    >
      <span className="eyebrow" style={{ letterSpacing: '0.28em' }}>
        {REORDER_FORWARD_COPY.eyebrow}
      </span>
      <h2 id="reorder-forward-heading" className="h3 mt-2">
        {REORDER_FORWARD_COPY.heading}
      </h2>
      <p className="body-soft mt-2" style={{ fontSize: 15 }}>
        {dated
          ? `${REORDER_FORWARD_COPY.lead} ${new Date(when).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}.`
          : REORDER_FORWARD_COPY.leadNoDate}
      </p>
      {/* Deliberately a real <Link>, not ButtonInk with a navigate() — this
          goes to another page, so middle-click and open-in-new-tab must work.
          The classes are ButtonInk's own (BASE + md + ink) restated, so it is
          pixel-identical to every other button on the page; if those change,
          change this too. */}
      <Link
        to={customerProofPath(link.proofId)}
        className="mt-4 inline-flex h-[38px] max-md:min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-[4px] bg-ink px-4 font-sans text-sm font-medium text-on-ink transition-colors hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
      >
        {REORDER_FORWARD_COPY.action}
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  )
}

export default ReorderPanel
