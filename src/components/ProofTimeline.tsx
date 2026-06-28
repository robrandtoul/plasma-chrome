import { useMemo, useState } from 'react'
import {
  Archive,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Eye,
  FileCheck2,
  FilePlus2,
  History,
  Layers,
  Mail,
  MessageSquare,
  Send,
  ThumbsDown,
  type LucideIcon,
} from 'lucide-react'
import { PanelShell, tokens } from '../design'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  buildTimelineEntries,
  type TimelineEntry,
  type TimelineEntryType,
  type TimelineSources,
} from '../lib/proofTimeline'
import {
  fetchConversationContext,
  type ConversationContext,
  type ConversationThread,
} from '../lib/conversationContext'

// Per-entry-type visual register. Customer-action types reuse the
// dashboard Latest-activity mapping (Eye/allocated, Check/in-stock,
// MessageSquare/low, Check/ink-mute) so "what happened" reads in the
// same hue on both surfaces; the milestone types extend the idiom.
const ENTRY_VISUAL: Record<TimelineEntryType, { icon: LucideIcon; tint: string }> = {
  project_created: { icon: FilePlus2, tint: tokens.brand },
  version_created: { icon: Layers, tint: tokens.ink },
  reply_sent: { icon: Send, tint: tokens.brand },
  // Automated/manual chase reminder. Same brand hue as reply_sent (both are
  // our outbound touch) but a bell glyph marks it as a reminder rather than
  // a genuine reply — so the cadence reads at a glance.
  reminder_sent: { icon: BellRing, tint: tokens.brand },
  // Unpaid-order payment reminder (send-order-reminders cron). A card glyph in
  // the amber "awaiting" hue marks it as an outbound chase about money owed,
  // distinct from the proof-approval reminder above.
  order_reminder_sent: { icon: CreditCard, tint: tokens.low },
  // Customer's inbound email reply — shares the "responded" hue used on the
  // dashboard for the same signal; Mail glyph distinguishes it from the
  // outbound Send reply and the in-app request_changes.
  customer_email_reply: { icon: Mail, tint: 'var(--c-responded)' },
  view: { icon: Eye, tint: tokens.allocated },
  approve: { icon: Check, tint: tokens.inStock },
  request_changes: { icon: MessageSquare, tint: tokens.low },
  designer_override_approve: { icon: Check, tint: tokens.inkMute },
  terms_acknowledged: { icon: FileCheck2, tint: tokens.allocated },
  proof_approved: { icon: CheckCircle2, tint: tokens.inStock },
  proof_abandoned: { icon: Archive, tint: tokens.inkMute },
  customer_declined: { icon: ThumbsDown, tint: 'var(--c-out)' },
}

// Entries shown before the "Show full history" expander kicks in.
// Covers a typical project's whole life in one screen; long
// back-and-forth histories collapse rather than dominating the page.
const COLLAPSED_COUNT = 10

// State + matched message handed to a reply_sent row so it can render
// the inline "Show message" reveal. Absent on every other entry type.
interface Reveal {
  expanded: boolean
  onToggle: () => void
  /** Conversation fetch lifecycle, shared across all reply rows. */
  state: 'idle' | 'loading' | 'loaded' | 'error'
  /** Staff reply matched to this row's send time; null until loaded / if unmatched. */
  thread: ConversationThread | null
  helpscoutUrl: string | null
}

// Pick the Help Scout thread a reply entry refers to. The timeline entry
// carries only a timestamp (last_reply_sent_at for our side,
// helpscout_last_customer_reply_at for theirs), and Help Scout holds the
// conversation as a flat thread, so we match on time: the closest thread of the
// requested author type (non-note, non-empty) is the one. `authorType` is
// 'user' for an outbound staff reply (reply_sent) or 'customer' for an inbound
// customer email reply (customer_email_reply). Notes and system rows are skipped.
function matchReplyThread(
  context: ConversationContext | null,
  atIso: string,
  authorType: 'user' | 'customer',
): ConversationThread | null {
  if (!context) return null
  const at = new Date(atIso).getTime()
  if (Number.isNaN(at)) return null
  let best: ConversationThread | null = null
  let bestDelta = Infinity
  for (const t of context.threads) {
    if (t.authorType !== authorType) continue
    if (t.type === 'note') continue
    if (t.bodyText.trim() === '') continue
    const ts = new Date(t.createdAt).getTime()
    if (Number.isNaN(ts)) continue
    const delta = Math.abs(ts - at)
    if (delta < bestDelta) {
      bestDelta = delta
      best = t
    }
  }
  return best
}

function TimelineRow({
  entry,
  isLast,
  reveal,
}: {
  entry: TimelineEntry
  isLast: boolean
  reveal?: Reveal
}) {
  const visual = ENTRY_VISUAL[entry.type]
  const Icon = visual.icon
  return (
    <li className="flex gap-3">
      {/* Node column: tinted 32px icon square + the rail segment
          connecting down to the next node. The rail lives per-item
          (rather than one absolute line) so it always starts and
          ends exactly at the node edges regardless of row height. */}
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
          style={{
            backgroundColor: `color-mix(in srgb, ${visual.tint} 14%, transparent)`,
            color: visual.tint,
          }}
        >
          <Icon size={16} />
        </span>
        {!isLast && <span aria-hidden="true" className="w-px flex-1 bg-line-soft mt-1.5 mb-1.5" />}
      </div>
      <div className={['min-w-0 flex-1 pt-1', isLast ? '' : 'pb-6'].join(' ')}>
        <p className="text-[14px] leading-snug text-ink">
          {entry.actor ? (
            <>
              <span className="font-semibold">{entry.actor}</span>{' '}
              <span className="text-ink-soft">{entry.verb}</span>
            </>
          ) : (
            <span className="font-medium">{entry.verb}</span>
          )}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {entry.recipientName && (
            <>
              <span className="text-[12px] leading-none text-ink-soft">
                for {entry.recipientName}
              </span>
              <span aria-hidden="true" className="text-[10px] leading-none text-ink-mute">
                ·
              </span>
            </>
          )}
          <span className="eyebrow text-ink-mute" title={formatAbsoluteDateTime(entry.at)}>
            {relativeTime(entry.at)}
          </span>
          {entry.failedNotification && (
            <span
              className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: tokens.lowSoft, color: tokens.low }}
              title="Help Scout notification failed — customer was asked to email."
            >
              notification failed
            </span>
          )}
        </div>
        {entry.comment && (
          <p
            className="mt-2 rounded-md border border-line-soft border-l-2 bg-canvas px-3 py-2 text-[13px] leading-[1.55] text-ink-soft whitespace-pre-wrap"
            style={{ borderLeftColor: visual.tint }}
          >
            {entry.comment}
          </p>
        )}
        {reveal && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={reveal.onToggle}
              aria-expanded={reveal.expanded}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-mute transition-colors hover:text-ink"
            >
              {reveal.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {reveal.expanded ? 'Hide message' : 'Show message'}
            </button>
            {reveal.expanded && (
              <div className="mt-2">
                {(reveal.state === 'idle' || reveal.state === 'loading') && (
                  <p className="text-[12px] text-ink-dim">Loading message…</p>
                )}
                {reveal.state === 'error' && (
                  <p className="text-[12px] text-ink-mute">
                    Couldn't load this message.{' '}
                    {reveal.helpscoutUrl && (
                      <a
                        href={reveal.helpscoutUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-ink"
                      >
                        Open in Help Scout
                      </a>
                    )}
                  </p>
                )}
                {reveal.state === 'loaded' && reveal.thread && (
                  <div
                    className="rounded-md border border-line-soft border-l-2 bg-canvas px-3 py-2"
                    style={{ borderLeftColor: visual.tint }}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-mute">
                      <span className="font-medium text-ink-soft">{reveal.thread.authorName}</span>
                      <span aria-hidden="true">·</span>
                      <span title={formatAbsoluteDateTime(reveal.thread.createdAt)}>
                        {relativeTime(reveal.thread.createdAt)}
                      </span>
                    </div>
                    <p className="text-[13px] leading-[1.55] text-ink-soft whitespace-pre-wrap">
                      {reveal.thread.bodyText}
                    </p>
                  </div>
                )}
                {reveal.state === 'loaded' && !reveal.thread && (
                  <p className="text-[12px] text-ink-mute">
                    This reply isn't showing in the linked Help Scout thread.{' '}
                    {reveal.helpscoutUrl && (
                      <a
                        href={reveal.helpscoutUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-ink"
                      >
                        Open in Help Scout
                      </a>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export interface ProofTimelineProps extends TimelineSources {
  /** Proof id, for the lazy Help Scout conversation fetch behind "Show message". */
  proofId?: string
  /** Whether the proof has a linked Help Scout conversation — gates the reveal. */
  hasHelpScout?: boolean
}

export default function ProofTimeline(props: ProofTimelineProps) {
  const { proofId, hasHelpScout } = props
  const entries = useMemo(
    () => buildTimelineEntries(props),
    // The page replaces these references wholesale on every loadProof,
    // so reference identity is the right memo key.
    [props.proof, props.versions, props.events, props.reminders, props.orderReminders, props.viewsByVersion, props.designerNamesById],
  )
  const [expanded, setExpanded] = useState(false)

  // Inline "Show message" reveal on reply_sent rows. The conversation
  // is fetched once, lazily, on the first reveal and shared across every
  // reply row (one conversation per proof); the page itself never pays
  // the Help Scout round-trip unless a designer actually opens a message.
  const [openMessageIds, setOpenMessageIds] = useState<ReadonlySet<string>>(() => new Set())
  const [context, setContext] = useState<ConversationContext | null>(null)
  const [contextState, setContextState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')

  function ensureContextLoaded() {
    if (contextState !== 'idle' || !proofId) return
    setContextState('loading')
    fetchConversationContext(proofId)
      .then((ctx) => {
        setContext(ctx)
        setContextState('loaded')
      })
      .catch(() => setContextState('error'))
  }

  function toggleMessage(id: string) {
    setOpenMessageIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    ensureContextLoaded()
  }

  const canReveal = !!hasHelpScout && !!proofId

  const visible = expanded ? entries : entries.slice(0, COLLAPSED_COUNT)
  const hiddenCount = entries.length - visible.length

  return (
    <PanelShell
      title="Activity"
      eyebrow="Project history"
      icon={History}
      accent={tokens.brand}
      count={entries.length}
      padded={false}
    >
      <ol className="px-5 pt-5 pb-4">
        {visible.map((entry, i) => (
          <TimelineRow
            key={entry.id}
            entry={entry}
            isLast={i === visible.length - 1}
            reveal={
              canReveal && (entry.type === 'reply_sent' || entry.type === 'customer_email_reply')
                ? {
                    expanded: openMessageIds.has(entry.id),
                    onToggle: () => toggleMessage(entry.id),
                    state: contextState,
                    thread: contextState === 'loaded'
                      ? matchReplyThread(context, entry.at, entry.type === 'reply_sent' ? 'user' : 'customer')
                      : null,
                    helpscoutUrl: context?.url ?? null,
                  }
                : undefined
            }
          />
        ))}
      </ol>
      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="block w-full border-t border-line-soft px-5 py-3 text-center text-[13px] font-medium text-ink-soft transition-colors hover:bg-canvas hover:text-ink"
        >
          {expanded ? 'Show fewer' : `Show full history (${hiddenCount} more)`}
        </button>
      )}
    </PanelShell>
  )
}
