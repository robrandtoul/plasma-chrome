import { useCallback, useEffect, useRef, useState } from 'react'
import CardActionsMenu from '../../components/CardActionsMenu'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { formatPrice } from '../../lib/currency'
import { Pill, type PillColour } from '../../design'
// The desk owns the vocabulary (the nine pipeline states) and its own
// definition of "today". Both are imported rather than restated: if the
// register's idea of what is servable today drifted from the desk's, the two
// screens would quietly disagree about the same customers.
import { todayIsoLocal, type ProspectState, scoreReasonsWorthShowing } from '../../lib/reorderDesk'
import type { Currency } from '../../lib/types'

// Admin → Reorder register. The whole back book on one screen.
//
// Why it exists: proofs.reorder_prospects holds ~2,900 past customers —
// lifetime value, order cadence, when they last ordered and what they last
// bought — seeded from three years of Xero invoice history (migration 000389)
// and kept current by a nightly reconcile (000395). Until now the only admin
// view of it was four aggregate counts on Analytics → Re-engagement. You could
// see that the register was 2,914 rows; you could not search it, see who was
// coming up, check what we know about a customer before ringing them, or take
// anyone out of it. It is quietly the most complete picture of the back book
// we have — Admin → Customers only knows the post-system world.
//
// This page is a VIEW of the register, not the desk. The desk (the dashboard
// panel) serves five a day off the top of it and does the outreach; nothing
// here sends anything to anyone. The only writes are supply control: rest a
// customer, never contact them again, or put them back.
//
// Reads and writes go straight to proofs.reorder_prospects over the
// authenticated RLS grant (000389: read/insert/update to authenticated) — no
// RPC needed, and deliberately none added, because every filter here is a
// plain PostgREST predicate.
//
// ⚠ 2,900 rows must never be fetched in one go, so the list is paged
// SERVER-side (.range) with an exact count for the footer.

const PAGE_SIZE = 50

// One rest is 90 days — the same window the desk's own "Not now" uses, so a
// customer rested from either surface comes back at the same time.
const REST_DAYS = 90

// Only the columns this page renders. Deliberately not the desk's
// PROSPECT_COLUMNS: that list is shaped for building an outreach proof (it
// carries follow-up timing and the Xero id), this one is shaped for reading a
// customer's history at a glance.
const SELECT_COLUMNS =
  'id, customer_name, email, currency, first_order_on, last_order_on, orders_count, ' +
  'lifetime_value, avg_order_value, cadence_days, last_spec, score, score_reasons, ' +
  'state, contacted_at, proof_id, outcome_note, suppressed_until, last_reconciled_at'

interface RegisterRow {
  id: string
  customer_name: string
  email: string | null
  currency: string | null
  first_order_on: string | null
  last_order_on: string | null
  orders_count: number | null
  lifetime_value: number | string | null
  avg_order_value: number | string | null
  cadence_days: number | null
  last_spec: string | null
  score: number | null
  score_reasons: string[] | null
  state: ProspectState
  contacted_at: string | null
  proof_id: string | null
  outcome_note: string | null
  suppressed_until: string | null
  last_reconciled_at: string | null
}

// ── Filters ──────────────────────────────────────────────────────────────────

// 'servable' is not a state — it is "state pending or queued AND not currently
// resting", i.e. exactly who the desk can offer tomorrow morning. It sits at
// the top of the list because it is the question this page is most often
// opened to answer.
const STATE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'Everyone on the register' },
  { value: 'servable', label: 'Servable today' },
  { value: 'pending', label: 'Waiting to be served' },
  { value: 'queued', label: 'On today’s desk' },
  { value: 'in_build', label: 'Project being built' },
  { value: 'contacted', label: 'Outreach sent' },
  { value: 'replied', label: 'Replied' },
  { value: 'accepted', label: 'Said yes — no order yet' },
  { value: 'converted', label: 'Ordered again' },
  { value: 'declined', label: 'Declined' },
  { value: 'closed_no_response', label: 'Closed — no response' },
  { value: 'suppressed', label: 'Never contact' },
]

const SORT_OPTIONS: { value: string; label: string; column: string }[] = [
  { value: 'score', label: 'Score — highest first', column: 'score' },
  { value: 'last_order', label: 'Last ordered — most recent', column: 'last_order_on' },
  { value: 'lifetime', label: 'Lifetime value — highest first', column: 'lifetime_value' },
  { value: 'orders', label: 'Orders — most first', column: 'orders_count' },
]

const STATE_PILL: Record<ProspectState, { colour: PillColour; label: string }> = {
  pending: { colour: 'neutral', label: 'Waiting' },
  queued: { colour: 'brand', label: 'On the desk' },
  in_build: { colour: 'allocated', label: 'Being built' },
  contacted: { colour: 'low', label: 'Outreach sent' },
  replied: { colour: 'brand', label: 'Replied' },
  // ⚠ 'Ordered again' is a claim about MONEY (000403). Approving a proof is not
  // buying one, so a customer who has said yes but not yet paid sits here, and
  // only a paid production order moves them on.
  accepted: { colour: 'brand', label: 'Said yes' },
  converted: { colour: 'in-stock', label: 'Ordered again' },
  declined: { colour: 'mute', label: 'Declined' },
  closed_no_response: { colour: 'mute', label: 'No response' },
  suppressed: { colour: 'out', label: 'Never contact' },
}

// ── Formatting ───────────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : 0
}

const KNOWN_CURRENCIES = new Set(['GBP', 'EUR', 'USD'])

// ⚠ Money is only ever shown per row, in that row's OWN currency, and the
// summary strip deliberately carries no money at all. The register mixes GBP,
// EUR and USD customers, and a "total lifetime value" across them would be a
// made-up number — the house rule everywhere else in this codebase.
function money(v: number | string | null, currency: string | null): string {
  if (v == null) return '—'
  const n = num(v)
  if (currency && KNOWN_CURRENCIES.has(currency)) return formatPrice(n, currency as Currency)
  // Unknown or missing currency: print the figure with whatever code we hold
  // rather than guessing a symbol. A wrong symbol is worse than none.
  const figure = n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return currency ? `${currency} ${figure}` : figure
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** YYYY-MM-DD, `days` from today, for the resting date. */
function isoInDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Is this row resting (rested earlier, date not yet reached)? */
function isResting(row: RegisterRow, today: string): boolean {
  return !!row.suppressed_until && row.suppressed_until > today
}

// PostgREST's `or=(…)` filter is a comma-and-bracket grammar, so a search term
// containing those characters would change the SHAPE of the query rather than
// the value being matched. Strip them (and the wildcard we add ourselves)
// instead of escaping — nobody searches a customer name for a bracket, and a
// silently malformed filter is far worse than a slightly narrowed one. Dots are
// left alone: they are legal inside a value, and every email has two.
function sanitiseSearch(raw: string): string {
  return raw.replace(/[,()*\\"]/g, ' ').trim()
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminReorderRegisterPage() {
  const [rows, setRows] = useState<RegisterRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Filters.
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState('all')
  const [sort, setSort] = useState('score')

  // Row actions.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Summary strip (whole register, independent of the filters below it).
  const [summary, setSummary] = useState<
    { total: number; servable: number; contacted: number; converted: number } | null
  >(null)
  const [summaryError, setSummaryError] = useState(false)

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])

  // Any filter change starts again at page 1 — otherwise a narrow filter lands
  // the reader on an empty page 4 of a 1-page result.
  useEffect(() => { setPage(1) }, [search, state, sort])

  const today = todayIsoLocal()

  // ── The summary strip ──────────────────────────────────────────────────────
  // Four head-only counts (no rows fetched), run once on mount and again after
  // a row action, since resting or suppressing someone changes them.
  const loadSummary = useCallback(async () => {
    const base = () => supabase.from('reorder_prospects').select('id', { count: 'exact', head: true })
    const notResting = `suppressed_until.is.null,suppressed_until.lte.${today}`
    const [all, servable, contacted, converted] = await Promise.all([
      base(),
      base().in('state', ['pending', 'queued']).or(notResting),
      // Matches analytics_reengagement's own "contacted" figure, which counts
      // replied alongside contacted — one outreach either way. Keeping the two
      // screens in step matters more than the finer split, which the state
      // filter below can still give you.
      base().in('state', ['contacted', 'replied']),
      base().eq('state', 'converted'),
    ])
    if (all.error || servable.error || contacted.error || converted.error) {
      setSummaryError(true)
      return
    }
    setSummaryError(false)
    setSummary({
      total: all.count ?? 0,
      servable: servable.count ?? 0,
      contacted: contacted.count ?? 0,
      converted: converted.count ?? 0,
    })
  }, [today])

  useEffect(() => { void loadSummary() }, [loadSummary])

  // ── The list ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setLoadError(null)

      const sortCol = SORT_OPTIONS.find((s) => s.value === sort)?.column ?? 'score'
      let q = supabase
        .from('reorder_prospects')
        .select(SELECT_COLUMNS, { count: 'exact' })
        .order(sortCol, { ascending: false, nullsFirst: false })
        // ⚠ Load-bearing tiebreaker. Hundreds of rows share a score, and
        // Postgres gives no order among equals — without a stable second key,
        // paging with .range() can show the same customer twice and skip
        // another entirely.
        .order('id', { ascending: true })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

      if (state === 'servable') {
        q = q.in('state', ['pending', 'queued']).or(`suppressed_until.is.null,suppressed_until.lte.${today}`)
      } else if (state !== 'all') {
        q = q.eq('state', state)
      }

      const term = sanitiseSearch(search)
      if (term) {
        q = q.or(
          `customer_name.ilike.*${term}*,email.ilike.*${term}*,last_spec.ilike.*${term}*`,
        )
      }

      const { data, error, count } = await q
      if (cancelled) return
      if (error) {
        setLoadError(error.message)
        setRows([])
        setTotal(0)
        setLoading(false)
        return
      }
      setRows((data ?? []) as unknown as RegisterRow[])
      setTotal(count ?? 0)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [search, state, sort, page, today])

  function onSearchChange(v: string) {
    setSearchDraft(v)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearch(v), 400)
  }

  function clearFilters() {
    setSearchDraft('')
    setSearch('')
    setState('all')
    setSort('score')
  }

  // ── Row actions ────────────────────────────────────────────────────────────
  //
  // Optimistic: patch the row in place, then await the write and put the old
  // row back if it fails. The write is AWAITED deliberately — a bare
  // `void supabase.from(...).update(...)` never sends the request at all, which
  // has shipped as a real bug in this repo before (CLAUDE.md, "supabase-js
  // queries are lazy").
  //
  // A row whose new state no longer matches the current filter is left where it
  // is rather than yanked off the screen mid-click; the next fetch drops it.
  async function patchRow(id: string, patch: Partial<RegisterRow>, audit: () => void) {
    const before = rows.find((r) => r.id === id)
    if (!before || busyId) return
    setActionError(null)
    setBusyId(id)
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

    const { error } = await supabase
      .from('reorder_prospects')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      setRows((rs) => rs.map((r) => (r.id === id ? before : r)))
      setActionError(`Could not save that change: ${error.message}`)
      setBusyId(null)
      return
    }
    audit()
    setBusyId(null)
    void loadSummary()
  }

  // Rest: stop offering this customer for 90 days.
  //
  // The state half is deliberately asymmetric. From a pre-outreach state
  // (waiting / on the desk / being built) the row goes back to 'pending' so a
  // half-served card returns to the pool rested — the same thing the desk's own
  // "Not now" does. From a post-outreach state the state is left ALONE: it is
  // the record of what actually happened to that customer, and overwriting it
  // with 'pending' would erase the fact that we contacted them.
  function rest(row: RegisterRow) {
    const preOutreach = row.state === 'pending' || row.state === 'queued' || row.state === 'in_build'
    void patchRow(
      row.id,
      {
        suppressed_until: isoInDays(REST_DAYS),
        ...(preOutreach ? { state: 'pending' as ProspectState } : {}),
      },
      () => void logAudit({
        action: 'reorder_desk.skipped',
        targetType: 'reorder_prospect',
        targetId: row.id,
        targetLabel: row.customer_name,
        metadata: { mode: 'later', days: REST_DAYS, source: 'register' },
      }),
    )
  }

  // Never contact: out of the register's supply for good. Same state the desk's
  // own "Never" writes, so the two routes are indistinguishable afterwards.
  function suppress(row: RegisterRow) {
    void patchRow(
      row.id,
      { state: 'suppressed', outcome_note: 'Marked never-contact from the reorder register' },
      () => void logAudit({
        action: 'reorder_desk.skipped',
        targetType: 'reorder_prospect',
        targetId: row.id,
        targetLabel: row.customer_name,
        metadata: { mode: 'never', source: 'register' },
      }),
    )
  }

  // Restore: back into supply, with any rest date cleared, so the desk can
  // offer them again from tomorrow.
  function restore(row: RegisterRow) {
    void patchRow(
      row.id,
      { state: 'pending', suppressed_until: null },
      () => void logAudit({
        action: 'reorder_desk.restored',
        targetType: 'reorder_prospect',
        targetId: row.id,
        targetLabel: row.customer_name,
        metadata: { from: row.state, source: 'register' },
      }),
    )
  }

  const anyFilter = !!search || state !== 'all' || sort !== 'score'
  const firstIndex = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const lastIndex = (page - 1) * PAGE_SIZE + rows.length
  const hasMore = lastIndex < total

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-ink">Reorder register</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Every past customer we know about, with what they last bought and how often they buy.
        </p>
      </div>

      {/* ── What this list is, for anyone opening it cold ──────────────── */}
      <section className="mb-4 rounded-2xl bg-surface p-4 text-sm leading-relaxed text-ink-soft shadow-sm ring-1 ring-line">
        <p>
          The register was built from three years of Xero invoices, so it reaches back long before
          this system existed — Admin → Customers only knows the customers who have come through it.
          Every night it brings itself up to date: new orders paid through the app join the register,
          the figures on everyone already here are refreshed, and the scores are worked out again
          (being overdue by your own rhythm is most of what a high score means, and that changes by
          the day).
        </p>
        <p className="mt-2">
          This page only <em>shows</em> the register. The Reorder desk on the dashboard is what works
          it — five customers a day off the top of this list, each one contacted by a person, never
          automatically. The <span aria-hidden="true">…</span> menu on a row takes someone out of
          that supply, or puts them back.
        </p>
      </section>

      {/* ── Summary strip ───────────────────────────────────────────────── */}
      {summaryError ? (
        <p className="mb-4 rounded-2xl bg-low-soft px-3 py-3 text-sm text-low ring-1 ring-low">
          The register totals could not be counted, so they are left off rather than shown wrong.
          The list below is unaffected.
        </p>
      ) : (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile
            label="On the register"
            value={summary ? summary.total.toLocaleString() : '—'}
            sub="past customers on the books"
          />
          <SummaryTile
            label="Servable today"
            value={summary ? summary.servable.toLocaleString() : '—'}
            sub="waiting, and not resting"
          />
          <SummaryTile
            label="Outreach sent"
            value={summary ? summary.contacted.toLocaleString() : '—'}
            sub="contacted or replied"
          />
          <SummaryTile
            label="Ordered again"
            value={summary ? summary.converted.toLocaleString() : '—'}
            sub="came back and bought"
          />
        </div>
      )}

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <section className="mb-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">Search</span>
            <input
              type="search"
              placeholder="Customer, email, what they bought…"
              value={searchDraft}
              onChange={(e) => onSearchChange(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">Show</span>
            <select value={state} onChange={(e) => setState(e.target.value)} className={selectClass}>
              {STATE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className={selectClass}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          {anyFilter && (
            <button
              onClick={clearFilters}
              className="ml-auto text-sm text-ink-mute underline-offset-2 hover:text-ink hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </section>

      {actionError && (
        <p className="mb-4 rounded-2xl bg-out-soft px-3 py-3 text-sm text-out ring-1 ring-out">{actionError}</p>
      )}

      {/* ── List ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
          Failed to load the register: {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl bg-surface py-16 text-center shadow-sm ring-1 ring-line">
          {anyFilter ? (
            <>
              <p className="text-ink-dim">No past customers match these filters.</p>
              <button
                onClick={clearFilters}
                className="mt-2 text-sm text-ink-mute underline underline-offset-2 hover:text-ink"
              >
                Clear filters
              </button>
            </>
          ) : (
            <p className="text-ink-dim">
              The register is empty — it hasn’t been seeded from the order history yet.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="table-scroll overflow-y-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
            {/* ⚠ min-w, not just w-full. Inside .table-scroll (overflow-x:auto)
                a bare w-full table obeys the container and squeezes columns
                instead of scrolling — which is what wrapped the prose cells to
                roughly one word per line and pushed the status and action
                columns off the right edge. Given a floor it scrolls, and every
                column keeps a usable width. */}
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-line-soft">
                  <th className={thClass}>Customer</th>
                  <th className={thClass}>Last bought</th>
                  <th className={thClass}>Last ordered</th>
                  <th className={`${thClass} text-right`}>Orders</th>
                  <th className={`${thClass} text-right`}>Lifetime</th>
                  <th className={thClass}>Score</th>
                  <th className={thClass}>Where they are</th>
                  <th className={thClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pill = STATE_PILL[r.state] ?? { colour: 'neutral' as PillColour, label: r.state }
                  const resting = isResting(r, today)
                  const suppressed = r.state === 'suppressed'
                  const busy = busyId === r.id
                  const reasons = (r.score_reasons ?? []).filter(Boolean)
                  const extraReasons = scoreReasonsWorthShowing(reasons)
                  return (
                    <tr key={r.id} className="border-b border-line-soft align-top last:border-0">
                      <td className="px-3 py-3">
                        <div className="font-medium text-ink">{r.customer_name}</div>
                        {r.email ? (
                          <div className="truncate text-xs text-ink-mute" title={r.email}>{r.email}</div>
                        ) : (
                          // Worth showing: no email means the desk has to stop
                          // and ask a designer for one before it can do anything.
                          <div className="text-xs text-ink-dim">No email on record</div>
                        )}
                        {r.proof_id && (
                          <Link
                            to={`/proofs/${r.proof_id}`}
                            className="mt-1 inline-block text-xs text-brand underline-offset-2 hover:underline"
                          >
                            Open their project
                          </Link>
                        )}
                      </td>

                      <td className="min-w-[10rem] max-w-[15rem] px-3 py-3 text-ink-soft">
                        {r.last_spec ?? <span className="text-ink-dim">—</span>}
                      </td>

                      <td className="whitespace-nowrap px-3 py-3 text-ink-mute">
                        {fmtDate(r.last_order_on)}
                        {r.cadence_days != null && (
                          <div className="text-xs text-ink-dim">
                            usually every {Math.round(r.cadence_days / 30)} months
                          </div>
                        )}
                      </td>

                      <td className="px-3 py-3 text-right tabular-nums text-ink-soft">
                        {r.orders_count ?? 0}
                      </td>

                      {/* Each row in its OWN currency — never added up. */}
                      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-ink-soft">
                        {money(r.lifetime_value, r.currency)}
                      </td>

                      {/* The number, and ONLY the part of the reasoning the row
                          doesn't already state three columns to the left. The
                          full list stays on the title for anyone who wants it. */}
                      <td
                        className="min-w-[9rem] px-3 py-3"
                        title={reasons.length > 0 ? reasons.join(' · ') : undefined}
                      >
                        <div className="font-semibold tabular-nums text-ink">{r.score ?? 0}</div>
                        {extraReasons.length > 0 && (
                          <div className="mt-0.5 text-xs leading-snug text-ink-mute">
                            {extraReasons.join(' · ')}
                          </div>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-3 py-3">
                        <Pill colour={pill.colour}>{pill.label}</Pill>
                        {resting && !suppressed && (
                          <div className="mt-1 text-xs text-ink-dim">
                            Resting until {fmtDate(r.suppressed_until)}
                          </div>
                        )}
                        {r.contacted_at && (
                          <div className="mt-1 text-xs text-ink-dim">
                            Contacted {fmtDate(r.contacted_at)}
                          </div>
                        )}
                      </td>

                      {/* One overflow menu, not three stacked buttons. Three
                          buttons cost roughly eight columns' worth of width and
                          pushed themselves off the right of the table — so the
                          page's only controls were the part you couldn't reach.
                          Same CardActionsMenu the Orders page uses. */}
                      <td className="w-12 whitespace-nowrap px-3 py-3 text-right">
                        <CardActionsMenu
                          label={`Actions for ${r.customer_name}`}
                          items={[
                            ...(!suppressed
                              ? [{ label: 'Rest 90 days', onClick: () => rest(r), disabled: busy }]
                              : []),
                            ...(suppressed || resting
                              ? [{ label: 'Put back on the register', onClick: () => restore(r), disabled: busy }]
                              : []),
                            ...(!suppressed
                              ? [{
                                  label: 'Never contact',
                                  onClick: () => suppress(r),
                                  disabled: busy,
                                  tone: 'danger' as const,
                                }]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm text-ink-mute">
            <div>
              Showing {firstIndex} to {lastIndex} of {total.toLocaleString()} past customers
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded px-3 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasMore}
                className="rounded px-3 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function SummaryTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl bg-surface p-3 shadow-sm ring-1 ring-line">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-ink-mute">{sub}</div>
    </div>
  )
}

const selectClass = 'select-styled min-w-[12rem] rounded border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
const inputClass = 'rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
const thClass = 'px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim'
