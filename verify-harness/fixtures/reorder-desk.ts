// Fixtures for the dashboard REORDER DESK panel (?path=/reorder-desk) in the
// verify harness.
//
// Owned by the reorder-desk e2e work — mock-supabase.ts delegates to these
// hooks FIRST and falls through to its own fixtures when they return null.
// The contract that keeps parallel work safe: only claim requests that belong
// to THIS area's fixture ids (prefix `rd-`), return null for everything else.
//
// The panel's complete data surface, derived from ReorderDeskPanel.tsx +
// src/lib/reorderDesk.ts:
//
//   on load   settings           — reorder_desk_* keys (NOT claimed here: the
//               shared mock's settings row carries none of them, so the lib's
//               fail-safes apply — enabled false is irrelevant to the rig,
//               which mounts the panel directly; dailyLimit 5 leaves room
//               for the pending promotion below; followupDays 5)
//             reorder_prospects  — .in('state', [queued|in_build|contacted|replied])
//             reorder_prospects  — .eq('state', 'pending') (or/order/limit
//               chain as no-ops in the mock — fine, one pending row)
//             reorder_prospects  — .eq('queued_on', today) (the daily-budget
//               read; re-returns the two queued-today rows, deliberately —
//               planDesk dedupes the merged fetches by id, so the rig
//               exercises that for free)
//             proofs             — .in('id', rd-proof ids): status +
//               helpscout_last_customer_reply_at (null here — no repliers,
//               so no row ever leaves the follow-up buckets via toReply)
//             proof_versions     — .in('proof_id', rd-proof ids)
//             proof_version_views— .eq('is_bot', false).in('proof_version_id', …)
//             reorder_prospects  — head count .gte('contacted_at', a week ago)
//             rpc reorder_prospects_recently_active — the serve-time recency
//               guard (000395), claimed by name and returning no ids, so the
//               rig's customers are all servable (see the hook)
//   writes    reorder_prospects  — promote (.in('id')), skip / put back /
//               sent-it-myself / follow-up stamp (.eq('id')); proofs
//               quiet-close status flip (.eq('id')). All acknowledged and
//               dropped (stateless mock).
//   follow-up proofs             — .eq('id', rd-proof-2).single() detail read
//             proof_versions     — .eq('proof_id', rd-proof-2).eq('is_current', true)
//             invoke fetch-helpscout-conversation-context — claimed for rd-
//               proofs with an empty thread list (the compose box needs a
//               linked conversation to render at all)
//             reply_templates    — NOT claimed: falls through to the shared
//               mock's empty resolution, so MessageSendPanel exercises its
//               DEFAULT_BODIES fallback.
//   analytics rpc analytics_reengagement — Admin → Analytics → Re-engagement,
//               claimed by name (the RPC is this feature's own; see the hook)
//               with a seeded happy-path payload.
//
// The two reorder_prospects list reads and the head count carry no rd- id in
// their filters, so — same URL-scoping precedent as version-form.ts — they
// are claimed only while the harness is actually mounting /reorder-desk. The
// table itself exists nowhere else in the mock, but the scope keeps this
// module inert for every other page regardless.
//
// Fixture population (one prospect per desk bucket):
//   rd-q-ada      queued today, email on file          → Today
//   rd-q-noemail  queued today, email NULL             → Today (Start reveals
//                                                        the inline email field)
//   rd-p-fresh    pending, highest score               → Today, via promotion
//   rd-b-build    in_build, proof rd-proof-1           → In build
//   rd-f-opened   contacted, due, proof rd-proof-2 has a non-bot view
//                                                      → Opened, gone quiet
//   rd-f-quiet    contacted, due, proof rd-proof-3 never viewed
//                                                      → No response

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HookQueryState } from './customer-proof'

const rd = (v: unknown): v is string => typeof v === 'string' && v.startsWith('rd-')
const rdAll = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => rd(x))

// Mirrors entry.tsx's ?path= / #hash resolution, scoped to this area's rig.
function onReorderDeskPage(): boolean {
  if (typeof window === 'undefined') return false
  const path =
    new URLSearchParams(window.location.search).get('path') ??
    (window.location.hash ? window.location.hash.replace(/^#/, '') : '')
  return path === '/reorder-desk'
}

// The admin register page (/admin/reorder-register). Kept separate from the
// desk rig above because the two read the SAME table with different query
// shapes, and a single predicate would have the register's paged list stealing
// the desk's state-filtered reads.
function onReorderRegisterPage(): boolean {
  if (typeof window === 'undefined') return false
  const path =
    new URLSearchParams(window.location.search).get('path') ??
    (window.location.hash ? window.location.hash.replace(/^#/, '') : '')
  return path === '/admin/reorder-register'
}

// Local-clock YYYY-MM-DD, matching todayIsoLocal in src/lib/reorderDesk.ts.
// Re-derived here rather than imported: pulling the lib in would drag its
// './supabase' import into this module, which in the harness aliases back to
// mock-supabase — a cycle. Three lines are cheaper than the cycle.
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TODAY = localIso(new Date())
const YESTERDAY = localIso(new Date(Date.now() - 864e5))
const daysAgoTs = (n: number) => new Date(Date.now() - n * 864e5).toISOString()

// Every PROSPECT_COLUMNS field present, so the panel's select gets the full
// shape the real table would return.
function prospect(overrides: Record<string, any>): Record<string, any> {
  return {
    id: 'rd-unset',
    xero_contact_id: null,
    customer_name: 'Unnamed Customer',
    email: null,
    currency: 'GBP',
    first_order_on: '2022-04-01',
    last_order_on: '2024-05-20',
    orders_count: 3,
    lifetime_value: 1450,
    avg_order_value: 480,
    cadence_days: 200,
    last_spec: '250 gold metal cards (500 micron)',
    score: 50,
    // Verbatim shape from live (see scoreReasonsWorthShowing): three clauses
    // that restate columns the table already prints, and — on the rows that
    // earn it — the one clause that adds something.
    score_reasons: [
      '3 previous orders',
      'last ordered ~15 months ago',
      '~£1450 lifetime',
      'overdue by their own rhythm (~every 7 months)',
    ],
    state: 'pending',
    queued_on: null,
    contacted_at: null,
    follow_up_due_on: null,
    followed_up_at: null,
    proof_id: null,
    matched_contact_id: null,
    outcome_note: null,
    suppressed_until: null,
    ...overrides,
  }
}

const PROSPECTS = [
  prospect({
    id: 'rd-q-ada',
    customer_name: 'Analytical Engines Ltd',
    email: 'ada@analytical.example',
    score: 80,
    state: 'queued',
    queued_on: TODAY,
  }),
  prospect({
    id: 'rd-q-noemail',
    customer_name: 'Difference & Partners',
    email: null,
    score: 70,
    state: 'queued',
    queued_on: TODAY,
  }),
  prospect({
    id: 'rd-p-fresh',
    customer_name: 'Jacquard Weaving Co',
    email: 'joseph@jacquard.example',
    score: 90,
    state: 'pending',
  }),
  prospect({
    id: 'rd-b-build',
    customer_name: 'Menabrea Notes',
    email: 'luigi@menabrea.example',
    score: 60,
    state: 'in_build',
    proof_id: 'rd-proof-1',
    matched_contact_id: 'rd-contact-1',
  }),
  prospect({
    id: 'rd-f-opened',
    customer_name: 'Byron Publishing',
    email: 'annabella@byron.example',
    score: 55,
    state: 'contacted',
    contacted_at: daysAgoTs(6),
    follow_up_due_on: YESTERDAY,
    proof_id: 'rd-proof-2',
    matched_contact_id: 'rd-contact-2',
  }),
  prospect({
    id: 'rd-f-quiet',
    customer_name: 'Somerville Prints',
    email: 'mary@somerville.example',
    score: 45,
    state: 'contacted',
    contacted_at: daysAgoTs(6),
    follow_up_due_on: YESTERDAY,
    proof_id: 'rd-proof-3',
    matched_contact_id: 'rd-contact-3',
  }),
]

// Outreach proofs, all still open — outcome sync (approved/abandoned
// elsewhere) is planDesk territory and unit-tested; the rig keeps every
// contacted row in the live follow-up buckets. Only the follow-up proof
// carries a Help Scout conversation: without one MessageSendPanel renders
// its no-conversation hatch instead of the compose box, and the whole point
// of the follow-up fixture is reaching the editable message.
const PROOFS = [
  { id: 'rd-proof-1', status: 'in_progress', helpscoutId: null as number | null, contactName: 'Luigi Menabrea', companyName: 'Menabrea Notes' },
  { id: 'rd-proof-2', status: 'in_progress', helpscoutId: 424242 as number | null, contactName: 'Annabella Byron', companyName: 'Byron Publishing' },
  { id: 'rd-proof-3', status: 'in_progress', helpscoutId: null as number | null, contactName: 'Mary Somerville', companyName: 'Somerville Prints' },
]

const VERSIONS = [
  { id: 'rd-ver-1', proof_id: 'rd-proof-1', version_number: 1 },
  { id: 'rd-ver-2', proof_id: 'rd-proof-2', version_number: 1 },
  { id: 'rd-ver-3', proof_id: 'rd-proof-3', version_number: 1 },
]

// "Opened" = a non-bot view. Only rd-proof-2's version has one — that is the
// whole difference between the follow-up row and the quiet-close row.
const VIEWS = [{ proof_version_id: 'rd-ver-2' }]

// .from() queries. Return { data, error: null } to claim, null to fall
// through. Single/maybeSingle claims must hand back the OBJECT (or null) —
// hook results bypass mock-supabase's own single-row unwrapping.
export function reorderDeskQuery(state: HookQueryState): { data: any; error: null; count?: number } | null {
  const { table, filters } = state

  if (table === 'reorder_prospects') {
    // ── The admin register page ────────────────────────────────────────────
    // Its four summary tiles are head-only counts; its table is one paged,
    // sorted, searchable read. Answered from the same PROSPECTS list so the
    // page renders REAL rows — the layout only misbehaves when there is
    // content in the prose cells, so an empty-state-only rig proved nothing
    // about the thing that was actually wrong with it.
    if (onReorderRegisterPage()) {
      if (state.head) {
        const st = filters['eq:state']
        const n = typeof st === 'string'
          ? PROSPECTS.filter((p) => p.state === st).length
          : PROSPECTS.length
        return { data: [], error: null, count: n }
      }
      let rows = PROSPECTS.slice()
      const st = filters['eq:state']
      if (typeof st === 'string') rows = rows.filter((p) => p.state === st)
      if (Array.isArray(filters['in:state'])) {
        rows = rows.filter((p) => (filters['in:state'] as string[]).includes(p.state))
      }
      return { data: rows, error: null, count: rows.length }
    }

    // No other fixture area owns this table, but the desk's list reads carry
    // no rd- id, so stay silent off the rig page anyway.
    if (!onReorderDeskPage()) return null
    // Writes first: promote arrives as .in('id', …), the per-row state moves
    // as .eq('id', …). Acknowledge and drop (the mock is stateless).
    if (filters['in:id'] || filters['eq:id']) return { data: null, error: null }
    // The panel's "contacted this week" head count.
    if (typeof filters['gte:contacted_at'] === 'string') {
      const since = filters['gte:contacted_at'] as string
      const n = PROSPECTS.filter((p) => p.contacted_at && p.contacted_at >= since).length
      return { data: [], error: null, count: n }
    }
    // The daily-budget read: everyone served today, whatever state they've
    // since moved to. Duplicates the queued-today rows on purpose — planDesk
    // dedupes the merged fetches by id.
    if (typeof filters['eq:queued_on'] === 'string') {
      return { data: PROSPECTS.filter((p) => p.queued_on === filters['eq:queued_on']), error: null }
    }
    // The live-states read.
    if (Array.isArray(filters['in:state'])) {
      return { data: PROSPECTS.filter((p) => filters['in:state'].includes(p.state)), error: null }
    }
    // The pending-pool slice.
    if (filters['eq:state'] === 'pending') {
      return { data: PROSPECTS.filter((p) => p.state === 'pending'), error: null }
    }
    return { data: [], error: null }
  }

  if (table === 'proofs') {
    // fetchDeskData's facts read across the outreach proofs. No repliers in
    // the rig — the reply column stays null so every contacted row keeps its
    // follow-up/quiet-close placement rather than syncing away via toReply.
    if (rdAll(filters['in:id'])) {
      return {
        data: PROOFS.filter((p) => filters['in:id'].includes(p.id)).map((p) => ({
          id: p.id,
          status: p.status,
          helpscout_last_customer_reply_at: null,
        })),
        error: null,
      }
    }
    if (rd(filters['eq:id'])) {
      const p = PROOFS.find((row) => row.id === filters['eq:id']) ?? null
      // Doubles as the follow-up modal's detail read (single) and the
      // quiet-close status flip's ack.
      return {
        data: p
          ? {
              id: p.id,
              status: p.status,
              helpscout_conversation_id: p.helpscoutId,
              contacts: { full_name: p.contactName, companies: { name: p.companyName } },
            }
          : null,
        error: null,
      }
    }
    return null
  }

  if (table === 'proof_versions') {
    if (rdAll(filters['in:proof_id'])) {
      return {
        data: VERSIONS.filter((v) => filters['in:proof_id'].includes(v.proof_id)).map((v) => ({
          id: v.id,
          proof_id: v.proof_id,
        })),
        error: null,
      }
    }
    // The follow-up modal's is_current read — single.
    if (rd(filters['eq:proof_id'])) {
      const v = VERSIONS.find((row) => row.proof_id === filters['eq:proof_id']) ?? null
      return { data: v ? { id: v.id, version_number: v.version_number } : null, error: null }
    }
    return null
  }

  if (table === 'proof_version_views' && rdAll(filters['in:proof_version_id'])) {
    return {
      data: VIEWS.filter((v) => filters['in:proof_version_id'].includes(v.proof_version_id)),
      error: null,
    }
  }

  return null
}

export function reorderDeskRpc(name: string, args?: any): { data: any; error: any } | null {
  // Admin → Analytics → Re-engagement (migration 000389). Claimed BY NAME:
  // the RPC belongs to this feature alone (only AdminAnalyticsPage calls it),
  // so a name key can't shadow another page's fixtures the way a table claim
  // could. Happy-path payload — non-zero register.total so the tab renders
  // its seeded shape (stat tiles + the weekly table) rather than the
  // "register is empty" panel; the register states sum to total, and the
  // weekly rows echo the outreach block, so the figures read as one story.
  if (name === 'analytics_reengagement') {
    return {
      data: {
        window_days: args?.p_days ?? 90,
        register: {
          total: 48,
          pending: 29,
          in_build: 2,
          contacted: 6,
          converted: 3,
          declined: 2,
          closed_no_response: 4,
          suppressed: 2,
        },
        outreach: {
          contacted_in_window: 9,
          opened: 6,
          approved: 3,
          paid: 2,
          paid_value: [{ currency: 'GBP', orders: 2, total: 1180 }],
        },
        weekly: [
          { week_start: '2026-07-13', contacted: 3, opened: 2, approved: 1, paid: 1 },
          { week_start: '2026-07-20', contacted: 2, opened: 1, approved: 0, paid: 0 },
          { week_start: '2026-07-27', contacted: 2, opened: 2, approved: 1, paid: 1 },
          { week_start: '2026-08-03', contacted: 2, opened: 1, approved: 1, paid: 0 },
        ],
      },
      error: null,
    }
  }
  // The serve-time recency guard (migration 000395), read by fetchDeskData on
  // every desk load. Claimed BY NAME for the same reason as the analytics one
  // above — it belongs to this feature alone. Returns NO ids: the rig's six
  // fixture customers are all genuinely due, so the guard holds nobody back
  // and every bucket lands exactly where the fixture comments promise.
  //
  // Claiming it rather than leaning on the mock's unknown-name fallback (also
  // an empty array) is the point: the desk's own reads should be visible here,
  // and a future rig that wants to prove the guard bites has one place to say
  // so — return an rd- id and that customer drops out of Today.
  if (name === 'reorder_prospects_recently_active') {
    return { data: [], error: null }
  }
  // The desk panel itself reads everything else through the query builder — no
  // other RPCs to claim. (logAudit's RPC resolves through the mock's generic
  // empty fallback.)
  return null
}

export function reorderDeskInvoke(name: string, body?: any): { data: any; error: any } | null {
  // MessageSendPanel's conversation-context read for the follow-up modal. An
  // empty thread list is enough: the compose box renders regardless, and the
  // context strip simply has no history to show.
  if (name === 'fetch-helpscout-conversation-context' && rd(body?.proof_id)) {
    const p = PROOFS.find((row) => row.id === body.proof_id)
    return {
      data: {
        conversation_id: p?.helpscoutId ?? 0,
        url: 'https://example.invalid/hs',
        threads: [],
      },
      error: null,
    }
  }
  return null
}
