import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import Modal from './Modal'
import MessageSendPanel from './MessageSendPanel'
import { attentionReason, attentionResolution, nudgeTemplateFor } from '../lib/needsAttention'
import { snoozeProof } from '../lib/snooze'
import { firstName } from '../lib/firstName'
import { customerProofPath } from '../lib/customerProofUrl'
import type { NeedsAttentionRule } from '../lib/dashboardGrouping'
import type { TemplateContext } from '../lib/replyTemplates'

// Click-to-open popover that explains a Needs-attention rule and lets the
// designer act on it without leaving the page: open the linked Help Scout
// thread, start a new version (for the request-changes rule), or send the
// customer a one-click reminder pre-filled from the rule's nudge template.
//
// Used on the dashboard reason chip and the proof detail page status pill. The
// card portals to document.body so it escapes the dashboard row's
// overflow-hidden; click-outside / Esc close it. Reuses MessageSendPanel for
// the actual send (context preview + templated reply + replies-paused
// handling), wrapped here with an opt-out "snooze after sending" checkbox.

// How long the auto-snooze holds the proof off the list after a reminder.
const SNOOZE_HOURS = 72 // 3 days

interface ResolvePopoverProps {
  proofId: string
  ruleCode: NeedsAttentionRule
  /** rule_meta.days — the threshold the rule fired against, where it has one. */
  days: number | undefined
  helpscoutUrl: string | null
  hasHelpscoutConversation: boolean
  /** Current version — needed to attribute a sent reminder. */
  versionId: string | null
  versionNumber: number | null
  /** Customer + version fields used to render the nudge template. */
  contactFullName: string | null
  companyName: string | null
  /** Called after a successful auto-snooze so the parent can refresh. */
  onSnoozed?: () => void
  /** The trigger element (the reason chip or the status pill). */
  children: ReactNode
  className?: string
}

const WIDTH = 280

export function ResolvePopover({
  proofId,
  ruleCode,
  days,
  helpscoutUrl,
  hasHelpscoutConversation,
  versionId,
  versionNumber,
  contactFullName,
  companyName,
  onSnoozed,
  children,
  className = '',
}: ResolvePopoverProps) {
  const navigate = useNavigate()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [showSend, setShowSend] = useState(false)
  const [snoozeAfterSend, setSnoozeAfterSend] = useState(true)

  const nudgeTemplate = nudgeTemplateFor(ruleCode)

  // Close on click-outside (ignoring the trigger + card) and on Esc.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || cardRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const messageContext: TemplateContext = {
    first_name: firstName(contactFullName ?? ''),
    full_name: contactFullName ?? '',
    company: companyName,
    version_number: versionNumber ?? '',
    url: `${window.location.origin}${customerProofPath(proofId)}`,
    designer_first_name: '',
  }

  async function handleSent() {
    if (snoozeAfterSend) {
      try {
        await snoozeProof(proofId, ruleCode, SNOOZE_HOURS, 'Reminder sent')
      } catch (err) {
        console.error('[ResolvePopover] auto-snooze failed:', err)
      }
    }
    setShowSend(false)
    setOpen(false)
    onSnoozed?.()
  }

  return (
    // Outer span only stops propagation: React portals (the card + modal
    // below) bubble events through the React tree, so without this a click
    // inside them would reach the dashboard row's onClick (navigation) and
    // the trigger's toggle (re-opening the popover behind the modal). The
    // open/close toggle lives on the inner trigger that wraps the children
    // only, so card/modal clicks never re-toggle it.
    <span
      ref={triggerRef}
      className={['inline-flex', className].filter(Boolean).join(' ')}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="inline-flex cursor-pointer" onClick={() => setOpen((v) => !v)}>
        {children}
      </span>

      {open && triggerRef.current && (
        <PopoverCard anchor={triggerRef.current} cardRef={cardRef}>
          <div className="text-[12px] leading-snug">
            <div className="font-semibold text-ink">Needs attention</div>
            <div className="mt-1 text-ink-soft">{attentionReason(ruleCode, days)}</div>
            <div className="mt-1.5 text-ink-soft">
              <span className="font-semibold text-ink">To resolve · </span>
              {attentionResolution(ruleCode)}
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              {/* Primary action — depends on the rule. */}
              {ruleCode === 'request_changes_no_version' ? (
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate(`/proofs/${proofId}/versions/new`) }}
                  className="inline-flex items-center justify-center rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-semibold text-on-ink hover:opacity-90"
                >
                  Start new version
                </button>
              ) : nudgeTemplate && hasHelpscoutConversation && versionId ? (
                <button
                  type="button"
                  onClick={() => { setOpen(false); setShowSend(true) }}
                  className="inline-flex items-center justify-center rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-semibold text-on-ink hover:opacity-90"
                >
                  Send a reminder
                </button>
              ) : nudgeTemplate && !hasHelpscoutConversation ? (
                <p className="text-[11px] text-ink-mute">No Help Scout conversation linked — reply manually.</p>
              ) : null}

              {/* Secondary — always offer the thread link when there is one. */}
              {helpscoutUrl && (
                <a
                  href={helpscoutUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-[6px] border border-line px-3 py-1.5 text-[12px] font-medium text-ink-soft hover:bg-canvas"
                >
                  Open Help Scout thread
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
        </PopoverCard>
      )}

      {/* Reminder send modal — reuses MessageSendPanel, pre-filled with the
          rule's nudge template, plus the opt-out auto-snooze checkbox. */}
      {showSend && nudgeTemplate && versionId && versionNumber != null && (
        <Modal
          open
          onClose={() => setShowSend(false)}
          ariaLabel="Send a reminder"
          panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
        >
          <label className="mb-4 flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={snoozeAfterSend}
              onChange={(e) => setSnoozeAfterSend(e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Snooze this proof for 3 days after sending
          </label>
          <MessageSendPanel
            proofId={proofId}
            versionId={versionId}
            versionNumber={versionNumber}
            templateId={nudgeTemplate}
            context={messageContext}
            hasHelpScoutConversation={hasHelpscoutConversation}
            onSent={handleSent}
            onSkip={() => setShowSend(false)}
            skipLabel="Cancel"
          />
        </Modal>
      )}
    </span>
  )
}

// Portaled popover card, positioned from the trigger's bounding rect. Same
// portal approach as ThumbnailPopover, but interactive (pointer-events enabled).
function PopoverCard({
  anchor,
  cardRef,
  children,
}: {
  anchor: HTMLElement
  cardRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const rect = anchor.getBoundingClientRect()
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - WIDTH - 16))
  // Prefer below the trigger; flip above when there isn't room beneath.
  const below = rect.bottom + 8
  const spaceBelow = window.innerHeight - rect.bottom
  const style: CSSProperties = spaceBelow > 240
    ? { left, top: below, width: WIDTH }
    : { left, bottom: window.innerHeight - rect.top + 8, width: WIDTH }

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      // z-30: above dashboard content but below the reminder Modal (backdrop
      // z-40 / panel z-50), so the popover can never sit in front of it.
      className="fixed z-30 rounded-[10px] border border-line bg-surface p-3 shadow-md"
      style={style}
    >
      {children}
    </div>,
    document.body,
  )
}

export default ResolvePopover
