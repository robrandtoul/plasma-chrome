import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { ButtonGhost, ButtonInk, Textarea } from '../design'
import { HOLD_COPY, HOLD_REASON_MAX, holdReasonError, type HeldState } from '../lib/orderHolds'

// "Put this order on hold" / "Take it off hold" — the two halves of the same
// decision, in one component so their copy can't drift apart.
//
// The asymmetry is deliberate. Putting a hold ON asks for a reason and refuses
// without one: a colleague who finds a blocked order needs to know whether to
// wait or to go ahead, and that is the entire job of the feature. Taking one
// OFF only confirms, and quotes the reason back — the friction that matters is
// reading what someone else was waiting for, not typing.
//
// Anyone can take a hold off, not just whoever set it. The team is five people
// and a hold sits on money already taken; holder-only would freeze a paid order
// behind one person's day off, which is a new way of getting stuck rather than
// a fix for the old one. What makes that safe is attribution and a push to the
// person who set it (migration 000377), not permission.

export interface HoldOrderDialogProps {
  mode: 'put' | 'take_off'
  /** Who the order is for, named in the copy so there's no doubt which one. */
  customerLabel: string
  /** The live hold, when taking one off — its reason is quoted back. */
  state: HeldState | null
  /**
   * Pre-filled reason, when the hold is being raised from an artwork-check
   * flag. The designer can edit it — the flag's wording is a starting point,
   * not the question they actually asked.
   */
  initialReason?: string
  working: boolean
  errorMsg: string | null
  onConfirm: (reason: string) => void
  onCancel: () => void
}

export default function HoldOrderDialog({
  mode,
  customerLabel,
  state,
  initialReason,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: HoldOrderDialogProps) {
  const [reason, setReason] = useState(initialReason ?? '')
  const [touched, setTouched] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  // Focus the reason box on open so the common case is type-and-confirm. Only
  // for 'put' — the take-off dialog's job is to be READ, and stealing focus to
  // a button invites the reflex Enter this dialog exists to prevent.
  useEffect(() => {
    if (mode === 'put') areaRef.current?.focus()
  }, [mode])

  const error = touched ? holdReasonError(reason) : null
  const canConfirm = !working && (mode === 'take_off' || !holdReasonError(reason))

  function submit() {
    setTouched(true)
    if (mode === 'take_off') {
      onConfirm('')
      return
    }
    if (holdReasonError(reason)) {
      areaRef.current?.focus()
      return
    }
    onConfirm(reason.trim())
  }

  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel={mode === 'put' ? HOLD_COPY.dialog_title : HOLD_COPY.take_off_title}
    >
      <div className="p-5">
        <h2 className="text-[17px] font-semibold text-ink">
          {mode === 'put' ? HOLD_COPY.dialog_title : HOLD_COPY.take_off_title}
        </h2>
        <p className="mt-1 text-[13px] text-ink-mute">{customerLabel}</p>

        {mode === 'put' ? (
          <>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{HOLD_COPY.dialog_body}</p>
            <label htmlFor="hold-reason" className="mt-4 block text-[13px] font-medium text-ink">
              {HOLD_COPY.reason_label}
            </label>
            <Textarea
              id="hold-reason"
              ref={areaRef}
              rows={3}
              value={reason}
              maxLength={HOLD_REASON_MAX}
              disabled={working}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={HOLD_COPY.reason_placeholder}
              className="mt-1.5"
              aria-invalid={!!error}
              aria-describedby="hold-reason-help"
            />
            <p id="hold-reason-help" className="mt-1.5 text-[12px] text-ink-mute">
              {HOLD_COPY.reason_help}
            </p>
            {error && <p className="mt-1.5 text-[13px] text-out">{error}</p>}
          </>
        ) : (
          <>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              {state?.byName ? `${state.byName} was waiting on:` : 'Waiting on:'}
            </p>
            <blockquote className="mt-2 rounded-lg border-l-[3px] border-low bg-[var(--c-low-soft)]/40 py-2 pl-3 pr-2 text-[14px] text-ink">
              {state?.reason}
            </blockquote>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Once it is off hold this order can be pushed into production, and the supplier email
              cannot be taken back. Only do this if the question has been settled.
            </p>
          </>
        )}

        {errorMsg && <p className="mt-3 text-[13px] text-out">{errorMsg}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <ButtonGhost type="button" onClick={onCancel} disabled={working}>
            Cancel
          </ButtonGhost>
          <ButtonInk type="button" onClick={submit} disabled={!canConfirm}>
            {working ? 'Saving…' : mode === 'put' ? HOLD_COPY.confirm : HOLD_COPY.take_off_confirm}
          </ButtonInk>
        </div>
      </div>
    </Modal>
  )
}
