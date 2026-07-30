import { useEffect, useState } from 'react'
import Modal from './Modal'
import { ButtonGhost, ButtonInk, Textarea } from '../design'
import { supabase } from '../lib/supabase'
import { DEFAULT_BODIES, renderTemplate } from '../lib/replyTemplates'
import {
  ABANDON_TEMPLATE_ID,
  abandonNoticeContext,
  type AbandonNotifyBlocker,
} from '../lib/abandonNotice'

// The Abandon-project confirm, with the optional "let the customer know" note.
//
// Replaces the plain ConfirmDialog this action used to render. Abandoning has
// always been silent — one row written, one designer toast, and the customer
// finding out only if they returned to their own link — so the checkbox starts
// UNTICKED and the silent path is byte-for-byte the old behaviour, right down
// to the confirm button's label. Most abandons are ghosted leads or a designer
// tidying up, where an unsolicited "we've closed your project" email would do
// more harm than good; the ones worth a note are the exception, so the
// exception is what you opt into.
//
// Modelled on OrdersPage's CancelOrderDialog (the same "does the customer hear
// about this?" decision, on the order side) but with the default the other way
// round and an editable body: an order cancellation is one fixed fact, whereas
// the reason a project stops varies enormously — price, a change of direction,
// silence — and the designer usually wants to add or soften a line.
//
// A bespoke Modal rather than ConfirmDialog because ConfirmDialog's panel is
// max-w-sm and its only interactive slot is a single checkbox; a textarea would
// have to be smuggled inside its `message` prop.

export interface AbandonProjectDialogProps {
  /** Who the note would go to — named in the copy so there's no doubt. */
  contactName: string
  companyName: string | null
  /**
   * Non-null when the notice can't be offered (no linked conversation, no
   * version to anchor it to, replies paused). The checkbox is then disabled
   * and explains itself rather than failing at send time.
   */
  blocker: AbandonNotifyBlocker | null
  working: boolean
  errorMsg: string | null
  /**
   * True when the project has already been closed but its notice failed to
   * send — the only outstanding work is the message. The dialog drops the
   * confirm-a-closure framing (that decision is made) and becomes a retry of
   * the send, so nothing offers to close a project that is already closed.
   */
  closedPendingNotice: boolean
  onConfirm: (opts: { notify: boolean; body: string }) => void
  onCancel: () => void
}

export default function AbandonProjectDialog({
  contactName,
  companyName,
  blocker,
  working,
  errorMsg,
  closedPendingNotice,
  onConfirm,
  onCancel,
}: AbandonProjectDialogProps) {
  const [notify, setNotify] = useState(false)
  const [body, setBody] = useState('')
  const [loadingTemplate, setLoadingTemplate] = useState(true)
  const [templateReadFailed, setTemplateReadFailed] = useState(false)

  // Load + render the template once on mount rather than when the box is
  // ticked, so ticking is instant and a slow query never looks like a broken
  // checkbox. Admin-edited row first, the shipped default second — the same
  // fetch-with-fallback one-liner the bundle workspace uses.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase
        .from('reply_templates')
        .select('body')
        .eq('id', ABANDON_TEMPLATE_ID)
        .maybeSingle()
      if (cancelled) return
      const template = (data?.body as string | undefined)?.trim() || DEFAULT_BODIES[ABANDON_TEMPLATE_ID]
      // Falling back is right when the row is genuinely absent (a deploy that
      // lands ahead of the migration). It is NOT right when the row exists but
      // couldn't be read — the designer would send stock copy in place of the
      // wording Rob configured, with nothing to show for it. Say so.
      setTemplateReadFailed(!!error)
      setBody(renderTemplate(template, abandonNoticeContext({ fullName: contactName, companyName })))
      setLoadingTemplate(false)
    })()
    return () => { cancelled = true }
  }, [contactName, companyName])

  const canNotify = blocker == null
  const bodyEmpty = body.trim() === ''
  // In the retry state the message is the only thing left to do, so the
  // checkbox is forced on: the designer already chose to notify, and offering
  // to un-choose it would just be a confusing way to abandon the retry (that's
  // what the dismiss button is for).
  const effectiveNotify = closedPendingNotice || (notify && canNotify)
  // Don't let a ticked box send nothing. Closing would still be correct, but
  // the designer asked for a message and wouldn't get one.
  const confirmDisabled = working || (effectiveNotify && (loadingTemplate || bodyEmpty))

  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabelledBy="abandon-dialog-title"
      ariaDescribedBy="abandon-dialog-msg"
      panelClassName="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl max-h-[85dvh] overflow-y-auto"
    >
      <h2 id="abandon-dialog-title" className="text-lg font-semibold text-ink">
        {closedPendingNotice ? 'The message didn’t send' : 'Abandon this project?'}
      </h2>
      <p id="abandon-dialog-msg" className="mt-2 text-sm text-ink-soft">
        {closedPendingNotice
          ? `The project is closed. ${contactName || 'The customer'} hasn’t been told yet — try again below, or dismiss this and message them yourself in Help Scout.`
          : 'This will lock the project. No new proof versions can be added, and the customer-facing page will show a closed state. You can reopen the project later if needed.'}
      </p>

      {!closedPendingNotice && (
        <>
          <label
            className={`mt-4 flex items-start gap-2 text-sm ${canNotify ? 'text-ink' : 'text-ink-mute'}`}
          >
            <input
              type="checkbox"
              checked={effectiveNotify}
              onChange={(e) => setNotify(e.target.checked)}
              disabled={working || !canNotify}
              className="mt-0.5"
            />
            <span>Let {contactName || 'the customer'} know</span>
          </label>
          <p className="mt-1.5 pl-6 text-[13px] text-ink-mute">
            {!canNotify
              ? blocker.detail
              : effectiveNotify
                ? 'We’ll post this on their Help Scout thread and close the conversation. If they reply, it reopens.'
                : 'Closed silently — nothing is sent. They’ll only find out if they come back to their link, which shows a quiet closed page.'}
          </p>
        </>
      )}

      {effectiveNotify && (
        <div className="mt-4">
          <label
            htmlFor="abandon-notice-body"
            className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-dim"
          >
            Message
          </label>
          <Textarea
            id="abandon-notice-body"
            // 9 fits the default body's eight wrapped lines with a little
            // headroom. The designer should be able to read the whole
            // message they're about to send without scrolling a box —
            // that's the entire point of showing it.
            rows={9}
            value={loadingTemplate ? '' : body}
            onChange={(e) => setBody(e.target.value)}
            disabled={working || loadingTemplate}
            placeholder={loadingTemplate ? 'Loading the message…' : undefined}
            invalid={!loadingTemplate && bodyEmpty}
          />
          <p className="mt-1.5 text-[13px] text-ink-mute">
            Edit it however you like. Our sign-off is added automatically. You can change the
            default wording in Admin → Content → Messages.
          </p>
          {templateReadFailed && (
            <p className="mt-1.5 text-[13px] text-out">
              We couldn’t load the saved wording just now, so this is the standard message — check
              it reads the way you want before sending.
            </p>
          )}
        </div>
      )}

      {errorMsg && (
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{errorMsg}</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        {/* "Keep project open" would be a lie in the retry state — the project
            is already closed and this button only dismisses the box. */}
        <ButtonGhost size="sm" onClick={onCancel} disabled={working}>
          {closedPendingNotice ? 'Leave it' : 'Keep project open'}
        </ButtonGhost>
        <ButtonInk
          size="sm"
          onClick={() => onConfirm({ notify: effectiveNotify, body })}
          disabled={confirmDisabled}
        >
          {closedPendingNotice
            ? working
              ? 'Sending…'
              : 'Try again'
            : working
              ? effectiveNotify
                ? 'Closing & sending…'
                : 'Abandoning…'
              : effectiveNotify
                ? 'Abandon & send'
                : 'Abandon project'}
        </ButtonInk>
      </div>
    </Modal>
  )
}
