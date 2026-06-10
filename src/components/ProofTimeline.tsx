import { useMemo, useState } from 'react'
import {
  Archive,
  Check,
  CheckCircle2,
  Eye,
  FileCheck2,
  FilePlus2,
  History,
  Layers,
  MessageSquare,
  Send,
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

// Per-entry-type visual register. Customer-action types reuse the
// dashboard Latest-activity mapping (Eye/allocated, Check/in-stock,
// MessageSquare/low, Check/ink-mute) so "what happened" reads in the
// same hue on both surfaces; the milestone types extend the idiom.
const ENTRY_VISUAL: Record<TimelineEntryType, { icon: LucideIcon; tint: string }> = {
  project_created: { icon: FilePlus2, tint: tokens.brand },
  version_created: { icon: Layers, tint: tokens.ink },
  reply_sent: { icon: Send, tint: tokens.brand },
  view: { icon: Eye, tint: tokens.allocated },
  approve: { icon: Check, tint: tokens.inStock },
  request_changes: { icon: MessageSquare, tint: tokens.low },
  designer_override_approve: { icon: Check, tint: tokens.inkMute },
  terms_acknowledged: { icon: FileCheck2, tint: tokens.allocated },
  proof_approved: { icon: CheckCircle2, tint: tokens.inStock },
  proof_abandoned: { icon: Archive, tint: tokens.inkMute },
}

// Entries shown before the "Show full history" expander kicks in.
// Covers a typical project's whole life in one screen; long
// back-and-forth histories collapse rather than dominating the page.
const COLLAPSED_COUNT = 10

function TimelineRow({ entry, isLast }: { entry: TimelineEntry; isLast: boolean }) {
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
      </div>
    </li>
  )
}

export default function ProofTimeline(sources: TimelineSources) {
  const entries = useMemo(
    () => buildTimelineEntries(sources),
    // The page replaces these references wholesale on every loadProof,
    // so reference identity is the right memo key.
    [sources.proof, sources.versions, sources.events, sources.viewsByVersion, sources.designerNamesById],
  )
  const [expanded, setExpanded] = useState(false)

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
          <TimelineRow key={entry.id} entry={entry} isLast={i === visible.length - 1} />
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
