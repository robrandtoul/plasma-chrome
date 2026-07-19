import { useCallback, useRef, useState, type ReactNode } from 'react'
import Modal from './Modal'

// The shared confirm / alert dialog.
//
// WHY THIS EXISTS. The app had three separate copy-pasted ConfirmDialog
// components (ProofDetailPage, customers/parts, AdminUsersPage) and around
// twenty raw window.confirm / window.alert calls scattered through the
// designer surfaces — including error reporting on the Orders page. The
// pattern existed but was never shared, so every new call site reached for the
// browser dialog instead: a grey OS box in the middle of an otherwise
// carefully-built interface, unstyleable and untestable.
//
// Lives beside Modal rather than in src/design because it is built ON Modal;
// putting it in the design system would invert the dependency.
//
// Two ways to use it:
//
//   <ConfirmDialog … />        — controlled, for dialogs whose open state is
//                                already tracked in page state.
//   const { confirm, dialog }  — promise-based, for replacing window.confirm
//     = useConfirm()             inside an event handler with almost no
//                                restructuring:
//
//     if (!(await confirm({ message: 'Delete this?', confirmLabel: 'Delete' }))) return
//
// The promise resolves true on confirm and false on cancel/dismiss, so the
// call site keeps window.confirm's shape while gaining the app's styling,
// focus-trap and Escape handling.

export interface ConfirmOptions {
  message: ReactNode
  /** Optional bold lead-in above the message. */
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Tailwind classes for the confirm button. Defaults to the ink button. */
  confirmClass?: string
  /** Alert mode: a single acknowledge button, no cancel. */
  acknowledgeOnly?: boolean
}

const DEFAULT_CONFIRM_CLASS = 'bg-ink text-on-ink hover:bg-ink-soft'

interface ConfirmDialogProps extends ConfirmOptions {
  /**
   * Defaults to true so the component is a drop-in for the page-local copies
   * it replaces, which were all rendered conditionally rather than toggled.
   */
  open?: boolean
  /** Disables both buttons and blocks dismissal while an action is in flight. */
  working?: boolean
  errorMsg?: string | null
  /** Independent gate on the confirm button (e.g. an "I've done X" checkbox). */
  confirmDisabled?: boolean
  checkbox?: { label: string; checked: boolean; onChange: (v: boolean) => void }
  onConfirm: () => void
  onCancel: () => void
}

let dialogIdCounter = 0

export default function ConfirmDialog({
  open = true,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmClass = DEFAULT_CONFIRM_CLASS,
  acknowledgeOnly = false,
  working = false,
  errorMsg,
  confirmDisabled,
  checkbox,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Seeded once per mount so the aria-describedby id is stable for this
  // dialog's lifetime.
  const [messageId] = useState(() => `confirm-dialog-msg-${++dialogIdCounter}`)
  if (!open) return null
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel={title ?? 'Confirm action'}
      ariaDescribedBy={messageId}
      panelClassName="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
    >
      {title && <h2 className="mb-2 text-base font-semibold text-ink">{title}</h2>}
      <div id={messageId} className="text-sm text-ink-soft">{message}</div>
      {errorMsg && (
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{errorMsg}</p>
      )}
      {checkbox && (
        <label className="mt-4 flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={checkbox.checked}
            onChange={(e) => checkbox.onChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>{checkbox.label}</span>
        </label>
      )}
      <div className="mt-5 flex justify-end gap-2">
        {!acknowledgeOnly && (
          <button
            type="button"
            onClick={onCancel}
            disabled={working}
            className="rounded px-4 py-2 max-md:min-h-[44px] text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
          >
            {cancelLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={working || !!confirmDisabled}
          className={`rounded px-4 py-2 max-md:min-h-[44px] text-sm font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)] ${confirmClass}`}
        >
          {working ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

// Promise-based confirm, for replacing window.confirm inside event handlers.
// Render `dialog` once anywhere in the component; call `confirm(...)` and await
// the boolean. `alert(...)` is the acknowledge-only variant, replacing
// window.alert for the error reports that used to fire a browser box.
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const confirm = useCallback((opts: ConfirmOptions) => {
    // A second call while one is open would strand the first promise; resolve
    // it as cancelled so no caller is left awaiting forever.
    resolverRef.current?.(false)
    setOptions(opts)
    return new Promise<boolean>((resolve) => { resolverRef.current = resolve })
  }, [])

  const alert = useCallback((message: ReactNode, title?: string) => {
    return confirm({ message, title, acknowledgeOnly: true, confirmLabel: 'OK' })
  }, [confirm])

  const dialog = options ? (
    <ConfirmDialog
      {...options}
      open
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null

  return { confirm, alert, dialog }
}
