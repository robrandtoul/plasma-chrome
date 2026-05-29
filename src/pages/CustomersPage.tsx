import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { relativeTime } from '../lib/relativeTime'
import { SelectField } from './customers/parts'

// Customers admin — lean list (PR 55) with server-side search + pagination
// (PR 56). One clickable row per company → per-company detail page where
// all editing lives. The list, its search, its sort, and its counts all
// resolve in the database via admin_search_customers (migration 000201),
// so the page no longer loads every company + 2000 project rows up front.

const PAGE_SIZE = 50

interface CompanyListRow {
  id: string
  name: string
  created_at: string
  contactCount: number
  proofCount: number
  lastActivityAt: string | null
}

interface Overview {
  companies: number
  contacts: number
  withProjects: number
}

interface OrphanSummary {
  contactCount: number
  proofCount: number
  lastActivityAt: string | null
}

type SortMode = 'alpha' | 'newest' | 'oldest' | 'active'

export default function CustomersPage() {
  const navigate = useNavigate()

  // Raw input vs the debounced query actually sent to the server.
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('alpha')
  const [page, setPage] = useState(0)

  const [companies, setCompanies] = useState<CompanyListRow[]>([])
  const [total, setTotal] = useState(0)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [orphan, setOrphan] = useState<OrphanSummary>({ contactCount: 0, proofCount: 0, lastActivityAt: null })
  const [loading, setLoading] = useState(true)

  // Add-company inline form
  const [addingCompany, setAddingCompany] = useState(false)
  const [companyNameDraft, setCompanyNameDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  // Debounce the search box so we hit the RPC once the typing settles,
  // not on every keystroke. Resets to page 0 whenever the query changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(searchInput.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Reset to the first page when the sort changes.
  useEffect(() => { setPage(0) }, [sortMode])

  // Fetch the current page from the server. A request counter guards
  // against an earlier slow response overwriting a later one.
  const reqRef = useRef(0)
  useEffect(() => {
    const reqId = ++reqRef.current
    setLoading(true)
    void (async () => {
      const { data, error } = await supabase.rpc('admin_search_customers', {
        p_search: searchQuery,
        p_sort: sortMode,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      })
      if (reqId !== reqRef.current) return // a newer request superseded us
      if (error || !data) {
        setCompanies([])
        setTotal(0)
        setLoading(false)
        return
      }
      const rows = (data.companies ?? []) as any[]
      setCompanies(rows.map((c) => ({
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        contactCount: c.contact_count ?? 0,
        proofCount: c.project_count ?? 0,
        lastActivityAt: c.last_activity_at ?? null,
      })))
      setTotal(data.total ?? 0)
      setOverview({
        companies: data.overview?.companies ?? 0,
        contacts: data.overview?.contacts ?? 0,
        withProjects: data.overview?.with_projects ?? 0,
      })
      setOrphan({
        contactCount: data.orphan?.contact_count ?? 0,
        proofCount: data.orphan?.project_count ?? 0,
        lastActivityAt: data.orphan?.last_activity_at ?? null,
      })
      setLoading(false)
    })()
  }, [searchQuery, sortMode, page])

  async function saveAddCompany() {
    const trimmed = companyNameDraft.trim()
    if (!trimmed) { setAddError('Name is required.'); return }
    setAddSaving(true)
    setAddError(null)
    const { data, error } = await supabase
      .from('companies').insert({ name: trimmed }).select('id, name').single()
    setAddSaving(false)
    if (error || !data) {
      setAddError((error as any)?.code === '23505' ? `A company called "${trimmed}" already exists.` : error?.message ?? 'Add failed.')
      return
    }
    void logAudit({ action: 'company.created', targetType: 'company', targetId: data.id, targetLabel: data.name })
    // Straight into the new company's detail page so adding a contact is
    // one click away.
    navigate(`/admin/customers/${data.id}`)
  }

  const searching = searchQuery.length > 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const onLastPage = page >= pageCount - 1
  // The "No company" row sits at the very end of the final page, and only
  // when it has contacts and matches the search (mirrors the old
  // "appended after all companies" behaviour).
  const orphanMatches = !searching || 'no company'.includes(searchQuery.toLowerCase())
  const showOrphan = orphan.contactCount > 0 && orphanMatches && onLastPage
  const hasResults = companies.length > 0 || showOrphan

  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Customers</h2>
          <p className="mt-1 text-sm text-ink-mute">
            {!overview
              ? 'Loading…'
              : `${overview.companies} ${overview.companies === 1 ? 'company' : 'companies'} · ${overview.contacts} ${overview.contacts === 1 ? 'contact' : 'contacts'} · ${overview.withProjects} with projects`}
          </p>
        </div>
        {!addingCompany && (
          <button
            onClick={() => { setAddingCompany(true); setCompanyNameDraft(''); setAddError(null) }}
            className="rounded bg-ink px-3 py-2 text-sm font-semibold text-on-ink hover:opacity-90"
          >
            Add company
          </button>
        )}
      </div>

      {addingCompany && (
        <div className="mb-6 rounded-2xl bg-white p-4 shadow-sm border border-line">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-mute">New company name</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="text"
              value={companyNameDraft}
              onChange={(e) => { setCompanyNameDraft(e.target.value); setAddError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveAddCompany(); if (e.key === 'Escape') setAddingCompany(false) }}
              autoFocus
              disabled={addSaving}
              className="min-w-0 flex-1 rounded border border-line bg-white px-2.5 py-1.5 text-sm text-ink shadow-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
              placeholder="e.g. Acme Ltd"
            />
            <button onClick={() => void saveAddCompany()} disabled={addSaving} className="rounded bg-ink px-3 py-1.5 text-xs font-semibold text-on-ink hover:opacity-90 disabled:opacity-50">
              {addSaving ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setAddingCompany(false)} disabled={addSaving} className="text-xs font-medium text-ink-mute hover:text-ink disabled:opacity-50">Cancel</button>
          </div>
          {addError && <p className="mt-2 rounded-md bg-out-soft px-3 py-1.5 text-xs text-out">{addError}</p>}
        </div>
      )}

      {/* Controls — search + sort. */}
      <div className="mb-6 rounded-2xl bg-white p-4 shadow-sm border border-line">
        <input
          type="search"
          placeholder="Search companies"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="w-full rounded-lg border border-line bg-white px-4 py-2.5 text-sm text-ink shadow-sm placeholder:text-ink-mute focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
        />
        <div className="mt-3 flex items-center gap-2">
          <SelectField
            label="Sort"
            value={sortMode}
            onChange={(v) => setSortMode(v)}
            options={[
              { value: 'alpha', label: 'Alphabetical' },
              { value: 'active', label: 'Recently active' },
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
            ]}
          />
        </div>
      </div>

      {loading && companies.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line" />
        </div>
      ) : !hasResults ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm border border-line">
          {searching ? (
            <>
              <p className="text-ink-mute">No companies match.</p>
              <button
                onClick={() => setSearchInput('')}
                className="mt-2 text-sm text-ink-mute underline underline-offset-2 hover:text-ink"
              >
                Clear search
              </button>
            </>
          ) : (
            <p className="text-ink-mute">No customers yet.</p>
          )}
        </div>
      ) : (
        <>
          <div className={['overflow-hidden rounded-2xl bg-white shadow-sm border border-line', loading ? 'opacity-60' : ''].join(' ')}>
            {companies.map((c, i) => (
              <CompanyRow
                key={c.id}
                name={c.name}
                contactCount={c.contactCount}
                proofCount={c.proofCount}
                lastActivityAt={c.lastActivityAt}
                withTopBorder={i > 0}
                onClick={() => navigate(`/admin/customers/${c.id}`)}
              />
            ))}
            {showOrphan && (
              <CompanyRow
                name="No company"
                muted
                contactCount={orphan.contactCount}
                proofCount={orphan.proofCount}
                lastActivityAt={orphan.lastActivityAt}
                withTopBorder={companies.length > 0}
                onClick={() => navigate('/admin/customers/none')}
              />
            )}
          </div>

          {/* Pagination — only when there's more than one page. */}
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs text-ink-mute">
                Showing {rangeStart}–{rangeEnd} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-xs text-ink-mute">Page {page + 1} of {pageCount}</span>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={onLastPage || loading}
                  className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CompanyRow({ name, muted, contactCount, proofCount, lastActivityAt, withTopBorder, onClick }: {
  name: string
  muted?: boolean
  contactCount: number
  proofCount: number
  lastActivityAt: string | null
  withTopBorder: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-canvas focus:outline-none focus-visible:bg-canvas',
        withTopBorder ? 'border-t border-line-soft' : '',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className={['truncate text-sm font-semibold', muted ? 'text-ink-mute italic' : 'text-ink'].join(' ')}>
          {name}
        </div>
        <div className="mt-0.5 text-xs text-ink-mute">
          {contactCount} {contactCount === 1 ? 'contact' : 'contacts'}
          {' · '}
          {proofCount} {proofCount === 1 ? 'project' : 'projects'}
        </div>
      </div>
      <span className="hidden shrink-0 text-xs text-ink-mute sm:inline">
        {lastActivityAt ? `Active ${relativeTime(lastActivityAt)}` : 'No activity'}
      </span>
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-ink-dim"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4.5 3 8.5 6 4.5 9" />
      </svg>
    </button>
  )
}
