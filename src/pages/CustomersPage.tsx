import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { relativeTime } from '../lib/relativeTime'
import { SelectField, type ProjectLite } from './customers/parts'

// Customers admin — lean list view (PR 55). One clickable row per company
// (plus a "No company" pseudo-row for contacts with no company), each
// leading to a per-company detail page where all the editing lives. The
// old version expanded contacts + projects inline on this page, which
// stacked up to four collapsible panels per company and didn't scale.

interface CompanyListRow {
  id: string
  name: string
  created_at: string
  contactCount: number
  proofCount: number
  lastActivityAt: string | null
}

interface OrphanSummary {
  contactCount: number
  proofCount: number
  lastActivityAt: string | null
}

type SortMode = 'alpha' | 'newest' | 'oldest' | 'active'

export default function CustomersPage() {
  const navigate = useNavigate()
  const [companies, setCompanies] = useState<CompanyListRow[]>([])
  const [orphan, setOrphan] = useState<OrphanSummary>({ contactCount: 0, proofCount: 0, lastActivityAt: null })
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('alpha')

  // Add-company inline form
  const [addingCompany, setAddingCompany] = useState(false)
  const [companyNameDraft, setCompanyNameDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  useEffect(() => { void load() }, [])

  async function saveAddCompany() {
    const trimmed = companyNameDraft.trim()
    if (!trimmed) { setAddError('Name is required.'); return }
    const conflict = companies.find((c) => c.name.toLowerCase() === trimmed.toLowerCase())
    if (conflict) { setAddError(`A company called "${conflict.name}" already exists.`); return }
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
    // Straight into the new company's detail page so the next step
    // (adding a contact) is one click away.
    navigate(`/admin/customers/${data.id}`)
  }

  async function load() {
    setLoading(true)
    // Project count + last-activity both come from public_dashboard_projects
    // (one row per proof that has a current version) — the same feed the
    // detail page and dashboard read. Counting contacts is the only thing
    // the companies query is for now. Single-sourcing the project figures
    // means the count and the "Active X ago" line can never disagree (the
    // old split between a nested proof_versions(count) and this view let a
    // company read "0 projects · Active 23h ago").
    const [companiesResult, orphanResult, projectsResult] = await Promise.all([
      supabase
        .from('companies')
        .select('id, name, created_at, contacts(id)')
        .order('name'),
      supabase
        .from('contacts')
        .select('id')
        .is('company_id', null),
      supabase
        .from('public_dashboard_projects')
        .select('proof_id, company_id, contact_id, last_activity_at')
        .order('last_activity_at', { ascending: false, nullsFirst: false })
        .limit(2000),
    ])

    // Per-company (and orphan) project count + most-recent activity.
    const rawProjects = (projectsResult.data ?? []) as Array<Pick<ProjectLite, 'company_id' | 'contact_id' | 'last_activity_at'>>
    const countByCompany = new Map<string, number>()
    const lastByCompany = new Map<string, string>()
    let orphanCount = 0
    let orphanLast: string | null = null
    for (const p of rawProjects) {
      if (p.company_id) {
        countByCompany.set(p.company_id, (countByCompany.get(p.company_id) ?? 0) + 1)
        if (p.last_activity_at) {
          const cur = lastByCompany.get(p.company_id)
          if (!cur || p.last_activity_at > cur) lastByCompany.set(p.company_id, p.last_activity_at)
        }
      } else if (p.contact_id) {
        orphanCount += 1
        if (p.last_activity_at && (!orphanLast || p.last_activity_at > orphanLast)) orphanLast = p.last_activity_at
      }
    }

    const rawCompanies = (companiesResult.data ?? []) as any[]
    const compRows: CompanyListRow[] = rawCompanies.map((c) => ({
      id: c.id,
      name: c.name,
      created_at: c.created_at,
      contactCount: ((c.contacts ?? []) as any[]).length,
      proofCount: countByCompany.get(c.id) ?? 0,
      lastActivityAt: lastByCompany.get(c.id) ?? null,
    }))

    const rawOrphans = (orphanResult.data ?? []) as any[]

    setCompanies(compRows)
    setOrphan({
      contactCount: rawOrphans.length,
      proofCount: orphanCount,
      lastActivityAt: orphanLast,
    })
    setLoading(false)
  }

  const { visibleCompanies, totals } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const comps = q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies

    const sorted = [...comps].sort((a, b) => {
      if (sortMode === 'alpha') return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      if (sortMode === 'newest') return b.created_at.localeCompare(a.created_at)
      if (sortMode === 'oldest') return a.created_at.localeCompare(b.created_at)
      // active — most recently active first; no activity sinks to the end
      const av = a.lastActivityAt ?? ''
      const bv = b.lastActivityAt ?? ''
      if (av === bv) return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      if (!av) return 1
      if (!bv) return -1
      return bv.localeCompare(av)
    })

    const companyContacts = companies.reduce((s, c) => s + c.contactCount, 0)
    const activeCount = companies.filter((c) => c.proofCount > 0).length
    return {
      visibleCompanies: sorted,
      totals: {
        companies: companies.length,
        contacts: companyContacts + orphan.contactCount,
        active: activeCount,
      },
    }
  }, [companies, orphan, searchQuery, sortMode])

  const searching = searchQuery.trim().length > 0
  const orphanMatches = !searching || 'no company'.includes(searchQuery.trim().toLowerCase())
  const showOrphan = orphan.contactCount > 0 && orphanMatches
  const hasResults = visibleCompanies.length > 0 || showOrphan

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Customers</h2>
          <p className="mt-1 text-sm text-ink-mute">
            {loading
              ? 'Loading…'
              : `${totals.companies} ${totals.companies === 1 ? 'company' : 'companies'} · ${totals.contacts} ${totals.contacts === 1 ? 'contact' : 'contacts'} · ${totals.active} with projects`}
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
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
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

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line" />
        </div>
      ) : !hasResults ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm border border-line">
          {searching ? (
            <>
              <p className="text-ink-mute">No companies match.</p>
              <button
                onClick={() => setSearchQuery('')}
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
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm border border-line">
          {visibleCompanies.map((c, i) => (
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
              withTopBorder={visibleCompanies.length > 0}
              onClick={() => navigate('/admin/customers/none')}
            />
          )}
        </div>
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
