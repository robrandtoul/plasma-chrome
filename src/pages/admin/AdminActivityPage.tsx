import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { downloadBlob } from '../../lib/downloadFile'
import AuditEntryModal, { type AuditEntry } from './AuditEntryModal'
import {
  ACTION_GROUPS,
  ACTION_LABELS,
  EMPTY_FILTERS,
  TARGET_TYPE_OPTIONS,
  filtersFromSearchParams,
  filtersToSearchParams,
  isAnyFilterActive,
  resolveDateRange,
  type AuditFilters,
  type DatePreset,
} from './auditFilters'

const PAGE_SIZE = 50

interface ActorOption {
  actor_id: string
  actor_email: string | null
  actor_label: string | null
  last_seen: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return 'Yesterday'
  if (diffDay <= 7) return `${diffDay} days ago`
  if (d.getFullYear() === new Date().getFullYear()) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // URL-synced filters.
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])

  // Local search draft (debounced onto the URL/filter state)
  const [searchDraft, setSearchDraft] = useState(filters.q)
  useEffect(() => { setSearchDraft(filters.q) }, [filters.q])

  // Entries + pagination state.
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  // Keyset cursor stack — each element is the (created_at, id) of the last
  // row of a previous page. Popping goes back to that page.
  const [cursorStack, setCursorStack] = useState<{ created_at: string; id: string }[]>([])
  const [hasMore, setHasMore] = useState(false)

  // Actor dropdown options.
  const [actors, setActors] = useState<ActorOption[]>([])

  // Modal state.
  const [openEntry, setOpenEntry] = useState<AuditEntry | null>(null)

  // CSV export state.
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reload from scratch when filters change.
  useEffect(() => {
    setPageNumber(1)
    setCursorStack([])
    void load(null, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.actor, filters.action, filters.targetType, filters.datePreset, filters.from, filters.to, filters.q])

  useEffect(() => { loadActors() }, [])

  async function loadActors() {
    const { data } = await supabase.rpc('list_audit_actors')
    const rows = ((data ?? []) as ActorOption[]).slice().sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))
    setActors(rows)
  }

  /** Apply the filter set to a query builder. Shared between the page
   *  fetch and the count fetch so they stay in sync. Cursor narrowing
   *  happens outside this, so the count is always for the whole filter. */
  function applyFilters(query: any): any {
    const { from, to } = resolveDateRange(filters)
    let q = query
    if (filters.actor === 'null') q = q.is('actor_id', null)
    else if (filters.actor) q = q.eq('actor_id', filters.actor)
    if (filters.action) q = q.eq('action', filters.action)
    if (filters.targetType) q = q.eq('target_type', filters.targetType)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to)
    if (filters.q) {
      const pattern = `%${filters.q.replace(/[,()]/g, '')}%`
      q = q.or(`actor_email.ilike.${pattern},actor_label.ilike.${pattern},target_label.ilike.${pattern}`)
    }
    return q
  }

  async function load(cursor: { created_at: string; id: string } | null, page: number) {
    setLoading(true)
    setLoadError(null)

    // Page rows (with cursor narrowing + limit).
    let pageQuery: any = supabase
      .from('audit_log')
      .select('id, actor_id, actor_email, actor_label, action, target_type, target_id, target_label, before_value, after_value, metadata, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1)
    pageQuery = applyFilters(pageQuery)
    if (cursor) {
      const { created_at, id } = cursor
      pageQuery = pageQuery.or(`created_at.lt.${created_at},and(created_at.eq.${created_at},id.lt.${id})`)
    }

    // Total count — filters only, no cursor — so the displayed "of N"
    // stays stable across pages of the same filter set.
    let countQuery: any = supabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
    countQuery = applyFilters(countQuery)

    const [pageResult, countResult] = await Promise.all([pageQuery, countQuery])
    if (pageResult.error) {
      setLoadError(pageResult.error.message)
      setLoading(false)
      return
    }
    const rows = (pageResult.data ?? []) as AuditEntry[]
    const hasNext = rows.length > PAGE_SIZE
    const pageRows = hasNext ? rows.slice(0, PAGE_SIZE) : rows
    setEntries(pageRows)
    setTotalCount(countResult.count ?? 0)
    setHasMore(hasNext)
    setPageNumber(page)
    setLoading(false)
  }

  function updateFilter(patch: Partial<AuditFilters>) {
    const next: AuditFilters = { ...filters, ...patch }
    setSearchParams(filtersToSearchParams(next))
  }

  function clearFilters() {
    setSearchParams(filtersToSearchParams(EMPTY_FILTERS))
  }

  function onSearchChange(v: string) {
    setSearchDraft(v)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      updateFilter({ q: v })
    }, 400)
  }

  function nextPage() {
    if (entries.length === 0) return
    const last = entries[entries.length - 1]
    setCursorStack((prev) => [...prev, last])
    void load({ created_at: last.created_at, id: last.id }, pageNumber + 1)
  }

  function prevPage() {
    if (cursorStack.length === 0) return
    const prevStack = cursorStack.slice(0, -1)
    const cursor = prevStack[prevStack.length - 1] ?? null
    setCursorStack(prevStack)
    void load(cursor, Math.max(1, pageNumber - 1))
  }

  async function handleExport() {
    setExportError(null)
    setExporting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      const { from, to } = resolveDateRange(filters)
      const qs = new URLSearchParams()
      if (filters.actor) qs.set('actor', filters.actor)
      if (filters.action) qs.set('action', filters.action)
      if (filters.targetType) qs.set('target_type', filters.targetType)
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      if (filters.q) qs.set('q', filters.q)
      const resp = await fetch(`${supabaseUrl}/functions/v1/export-audit-log?${qs}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`)
      const blob = await resp.blob()
      const filenameHeader = resp.headers.get('Content-Disposition') ?? ''
      const filename = filenameHeader.match(/filename="([^"]+)"/)?.[1] ?? 'audit_log.csv'
      downloadBlob(blob, filename)
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const firstIndex = entries.length === 0 ? 0 : (pageNumber - 1) * PAGE_SIZE + 1
  const lastIndex = (pageNumber - 1) * PAGE_SIZE + entries.length
  const anyFilter = isAnyFilterActive(filters)

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">Activity</h2>
        <p className="mt-1 text-sm text-gray-500">
          Every meaningful action by designers, admins and customers. Immutable record.
        </p>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <section className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Actor">
            <select
              value={filters.actor}
              onChange={(e) => updateFilter({ actor: e.target.value })}
              className={selectClass}
            >
              <option value="">All actors</option>
              <option value="null">Customer (not signed in)</option>
              {actors.map((a) => (
                <option key={a.actor_id} value={a.actor_id}>
                  {a.actor_label ?? a.actor_email ?? a.actor_id}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Action">
            <select
              value={filters.action}
              onChange={(e) => updateFilter({ action: e.target.value })}
              className={selectClass}
            >
              <option value="">All actions</option>
              {ACTION_GROUPS.map((g) => (
                <optgroup key={g.name} label={g.name}>
                  {g.actions.map((a) => (
                    <option key={a.code} value={a.code}>{a.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Target type">
            <select
              value={filters.targetType}
              onChange={(e) => updateFilter({ targetType: e.target.value })}
              className={selectClass}
            >
              <option value="">All types</option>
              {TARGET_TYPE_OPTIONS.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Date range">
            <select
              value={filters.datePreset}
              onChange={(e) => updateFilter({ datePreset: e.target.value as DatePreset })}
              className={selectClass}
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom</option>
            </select>
          </Field>

          {filters.datePreset === 'custom' && (
            <>
              <Field label="From">
                <input
                  type="date"
                  value={filters.from}
                  onChange={(e) => updateFilter({ from: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={filters.to}
                  onChange={(e) => updateFilter({ to: e.target.value })}
                  className={inputClass}
                />
              </Field>
            </>
          )}

          <Field label="Search">
            <input
              type="text"
              placeholder="Actor or target…"
              value={searchDraft}
              onChange={(e) => onSearchChange(e.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="ml-auto flex gap-2">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {anyFilter && (
              <button
                onClick={clearFilters}
                className="text-sm text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
        {exportError && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{exportError}</p>
        )}
      </section>

      {/* ── List ──────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
          Failed to load activity: {loadError}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
          {anyFilter ? (
            <>
              <p className="text-gray-400">No events match these filters.</p>
              <button
                onClick={clearFilters}
                className="mt-2 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
              >
                Clear filters
              </button>
            </>
          ) : (
            <p className="text-gray-400">No activity logged yet. Events appear here as they happen.</p>
          )}
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">When</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Actor</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Action</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Target</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setOpenEntry(e)}
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-5 py-3 whitespace-nowrap text-gray-500" title={formatAbsolute(e.created_at)}>
                      {formatRelative(e.created_at)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="truncate text-sm font-medium text-gray-900">{e.actor_label ?? '—'}</div>
                      {e.actor_email && e.actor_email !== e.actor_label && (
                        <div className="truncate text-xs text-gray-400">{e.actor_email}</div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-sm text-gray-900">{ACTION_LABELS[e.action] ?? e.action}</div>
                      <div className="font-mono text-[11px] text-gray-400">{e.action}</div>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-600">{e.target_label ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
            <div>
              Showing {firstIndex} to {lastIndex} of {totalCount.toLocaleString()} events
            </div>
            <div className="flex gap-2">
              <button
                onClick={prevPage}
                disabled={pageNumber <= 1}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={nextPage}
                disabled={!hasMore}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {openEntry && <AuditEntryModal entry={openEntry} onClose={() => setOpenEntry(null)} />}
    </div>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
      {children}
    </label>
  )
}

const selectClass = 'min-w-[10rem] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
const inputClass  = 'rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
