// Dev-only harness for proof-timeline-preview.html. Renders the
// ProofTimeline panel with realistic fixture props in two states
// (in-review with a long history, and a freshly-approved project)
// so the visual treatment can be checked without auth or a database.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ProofTimeline from './components/ProofTimeline'
import type { TimelineEventRow } from './lib/proofTimeline'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

// ── Fixture 1: split-name project mid-review ─────────────────────────────────

const versions = [
  { id: 'v1', version_number: 1, created_at: ago(9 * DAY), last_reply_sent_at: ago(9 * DAY - HOUR) },
  { id: 'v2', version_number: 2, created_at: ago(5 * DAY), last_reply_sent_at: ago(5 * DAY - HOUR / 2) },
]

const events: TimelineEventRow[] = [
  {
    id: 'e1',
    proof_version_id: 'v1',
    event_type: 'request_changes',
    actor_name: 'Tessa Fixture',
    name: 'John Smith',
    comment:
      'Could the logo come up about 20% larger? Also my mobile should end 788, not 778.',
    helpscout_thread_id: 'hs-1',
    created_at: ago(7 * DAY),
    variant_display_name: null,
  },
  {
    id: 'e2',
    proof_version_id: 'v2',
    event_type: 'approve',
    actor_name: 'Tessa Fixture',
    name: 'John Smith',
    comment: null,
    helpscout_thread_id: 'hs-2',
    created_at: ago(2 * DAY),
    variant_display_name: null,
  },
  {
    id: 'e3',
    proof_version_id: 'v2',
    event_type: 'approve',
    actor_name: 'Tessa Fixture',
    name: 'Jane Doe',
    comment: null,
    helpscout_thread_id: null, // exercises the "notification failed" chip
    created_at: ago(1 * DAY),
    variant_display_name: null,
  },
]

const viewsByVersion = new Map([
  ['v1', [
    { viewed_at: ago(8 * DAY) },
    { viewed_at: ago(8 * DAY - 12 * 60_000) }, // same day — deduped
    { viewed_at: ago(7 * DAY + 2 * HOUR) },
  ]],
  ['v2', [
    { viewed_at: ago(4 * DAY) },
    { viewed_at: ago(2 * DAY + 3 * HOUR) },
  ]],
])

// ── Fixture 2: approved project (milestone + tie-ordering visible) ───────────

const approvedAt = ago(1 * HOUR)
const approvedVersions = [
  { id: 'a1', version_number: 1, created_at: ago(3 * DAY), last_reply_sent_at: ago(3 * DAY - HOUR) },
]
const approvedEvents: TimelineEventRow[] = [
  {
    id: 'ae1',
    proof_version_id: 'a1',
    event_type: 'approve',
    actor_name: 'Marco Delgado',
    name: null,
    comment: 'Perfect — really happy with these.',
    helpscout_thread_id: 'hs-9',
    created_at: approvedAt,
    variant_display_name: null,
  },
]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="min-h-dvh bg-canvas p-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <ProofTimeline
          proof={{
            created_at: ago(9 * DAY + HOUR),
            approved_at: null,
            abandoned_at: null,
            disclaimer_acknowledged_at: ago(8 * DAY + HOUR),
            contactName: 'Tessa Fixture',
          }}
          versions={versions}
          events={events}
          viewsByVersion={viewsByVersion}
        />
        <ProofTimeline
          proof={{
            created_at: ago(3 * DAY + HOUR),
            approved_at: approvedAt,
            abandoned_at: null,
            disclaimer_acknowledged_at: null,
            contactName: 'Marco Delgado',
          }}
          versions={approvedVersions}
          events={approvedEvents}
          viewsByVersion={new Map([['a1', [{ viewed_at: ago(2 * DAY) }]]])}
        />
      </div>
    </div>
  </StrictMode>,
)
