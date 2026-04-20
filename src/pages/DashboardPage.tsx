import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type SortMode = 'date' | 'name'

const SORT_KEY         = 'proofViewer.dashboard.sort'
const SHOW_DORMANT_KEY = 'proofViewer.dashboard.showDormant'

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'name' ? 'name' : 'date'
  } catch {
    return 'date'
  }
}

function readShowDormant(): boolean {
  try {
    return localStorage.getItem(SHOW_DORMANT_KEY) === 'true'
  } catch {
    return false
  }
}

type Status = 'in_progress' | 'approved' | 'dormant' | 'abandoned'

interface ProofItem {
  id: string
  created_at: string
  current_version: number | null
  material_display: string | null
  status: Status
}

interface RecentProject {
  proofId: string
  customerName: string
  companyName: string | null
  materialDisplay: string
  status: Status
  lastWorkedAt: string
}

interface ContactGroup {
  contactId: string
  contactName: string
  proofs: ProofItem[]
}

interface CompanySection {
  companyKey: string       // company UUID or '__individual__' for no-company contacts
  companyName: string | null
  latestProofDate: string  // ISO string — used for date-sort ordering
  contacts: ContactGroup[]
}

// ── Section builder ───────────────────────────────────────────────────────────

function buildSections(rawProofs: any[], sort: SortMode, showDormant: boolean): CompanySection[] {
  const map = new Map<string, CompanySection>()

  for (const p of rawProofs) {
    const contact    = p.contacts        as any
    const company    = contact?.companies as any
    const companyKey  = company?.id   ?? '__individual__'
    const companyName: string | null = company?.name ?? null
    const contactId   = contact?.id   ?? ''
    const contactName = contact?.full_name ?? ''

    const status: ProofItem['status'] = p.status ?? 'in_progress'

    // When dormant proofs are hidden, skip them entirely
    if (!showDormant && status === 'dormant') continue

    if (!map.has(companyKey)) {
      map.set(companyKey, {
        companyKey,
        companyName,
        latestProofDate: p.created_at,
        contacts: [],
      })
    }

    const section = map.get(companyKey)!
    if (p.created_at > section.latestProofDate) {
      section.latestProofDate = p.created_at
    }

    let cg = section.contacts.find((c) => c.contactId === contactId)
    if (!cg) {
      cg = { contactId, contactName, proofs: [] }
      section.contacts.push(cg)
    }

    const versions = (p.proof_versions ?? []) as any[]
    const current  = versions.find((v) => v.is_current)
    cg.proofs.push({
      id: p.id,
      created_at: p.created_at,
      current_version:  current?.version_number   ?? null,
      material_display: current?.material_display ?? null,
      status,
    })
  }

  // Sort internals: active proofs newest-first, dormant proofs after (also newest-first)
  for (const section of map.values()) {
    for (const cg of section.contacts) {
      cg.proofs.sort((a, b) => {
        const aDormant = a.status === 'dormant' ? 1 : 0
        const bDormant = b.status === 'dormant' ? 1 : 0
        if (aDormant !== bDormant) return aDormant - bDormant
        return b.created_at.localeCompare(a.created_at)
      })
    }
    section.contacts.sort((a, b) =>
      a.contactName.localeCompare(b.contactName, 'en', { sensitivity: 'base' })
    )
  }

  // Separate "no company" — always pinned to the bottom
  const individual = map.get('__individual__') ?? null
  const sections   = [...map.values()].filter((s) => s.companyKey !== '__individual__')

  if (sort === 'date') {
    sections.sort((a, b) => b.latestProofDate.localeCompare(a.latestProofDate))
  } else {
    sections.sort((a, b) =>
      (a.companyName ?? '').localeCompare(b.companyName ?? '', 'en', { sensitivity: 'base' })
    )
  }

  if (individual) sections.push(individual)
  return sections
}

// ── Date formatting ───────────────────────────────────────────────────────────

// Relative date string used across both the Recent Projects card and the main
// grouped list: Today / Yesterday / N days ago / 14 Apr / 14 Apr 2025.
function formatRelative(iso: string): string {
  const now = new Date()
  const then = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const daysDiff = Math.floor((startOfToday.getTime() - startOfThen.getTime()) / 86_400_000)
  if (daysDiff <= 0) return 'Today'
  if (daysDiff === 1) return 'Yesterday'
  if (daysDiff <= 7) return `${daysDiff} days ago`
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Shared grid template so every row on this page — Recent Projects or main
// grouped list — lines Material/Status/Date/Preview/AddVersion up in the
// same horizontal positions. The leftmost column flexes for customer name
// in Recent or a "v3" label in the main list.
const ROW_GRID = 'grid items-center gap-3 grid-cols-[minmax(0,1fr)_8rem_7rem_5.5rem_5.5rem_6.5rem]'

// ── Recent projects ───────────────────────────────────────────────────────────

function buildRecent(versions: any[]): RecentProject[] {
  const seen = new Set<string>()
  const out: RecentProject[] = []
  for (const v of versions) {
    if (seen.has(v.proof_id)) continue
    seen.add(v.proof_id)
    out.push({
      proofId: v.proof_id,
      customerName: v.proofs?.contacts?.full_name ?? '',
      companyName: v.proofs?.contacts?.companies?.name ?? null,
      materialDisplay: v.material_display ?? '—',
      status: (v.proofs?.status ?? 'in_progress') as Status,
      lastWorkedAt: v.created_at,
    })
    if (out.length >= 10) break
  }
  return out
}

function StatusPill({ status }: { status: Status }) {
  if (status === 'approved') {
    return <span className="w-fit shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Approved</span>
  }
  if (status === 'abandoned') {
    return <span className="w-fit shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">Abandoned</span>
  }
  if (status === 'dormant') {
    return <span className="w-fit shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Dormant</span>
  }
  return <span className="w-fit shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">In progress</span>
}

function PreviewLink({ proofId }: { proofId: string }) {
  return (
    <a
      href={`/p/${proofId}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="w-fit shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
    >
      Preview
    </a>
  )
}

function AddVersionLink({ proofId }: { proofId: string }) {
  return (
    <Link
      to={`/proofs/${proofId}/versions/new`}
      onClick={(e) => e.stopPropagation()}
      className="w-fit shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
    >
      Add version
    </Link>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path strokeLinecap="round" d="M8 3v10M3 8h10" />
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate()
  const [rawProofs, setRawProofs]       = useState<any[]>([])
  const [recent, setRecent]             = useState<RecentProject[]>([])
  const [loading, setLoading]           = useState(true)
  const [search, setSearch]             = useState('')
  const [sort, setSort]                 = useState<SortMode>(readSort)
  const [showDormant, setShowDormant]   = useState(readShowDormant)

  useEffect(() => { loadProofs() }, [])

  async function loadProofs() {
    const userResult = await supabase.auth.getUser()
    const userId = userResult.data.user?.id ?? null

    const proofsPromise = supabase
      .from('proofs')
      .select(
        'id, created_at, status,' +
        'contacts(id, full_name, companies(id, name)),' +
        'proof_versions(version_number, is_current, material_display)'
      )
      .order('created_at', { ascending: false })

    // Recent projects this designer has worked on. We pull the latest
    // versions they created, then dedupe by proof_id client-side so each
    // project appears once. Fetching 50 rows is overkill for showing 10
    // projects but keeps the query simple.
    const recentPromise = userId
      ? supabase
          .from('proof_versions')
          .select(
            'proof_id, created_at, material_display,' +
            'proofs!inner(status, contacts(full_name, companies(name)))'
          )
          .eq('created_by', userId)
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as any[] })

    const [{ data: proofs }, { data: versions }] = await Promise.all([proofsPromise, recentPromise])

    setRawProofs(proofs ?? [])
    setRecent(buildRecent((versions ?? []) as any[]))
    setLoading(false)
  }

  function handleSortChange(s: SortMode) {
    setSort(s)
    try { localStorage.setItem(SORT_KEY, s) } catch { /* storage may be unavailable */ }
  }

  function toggleShowDormant() {
    const next = !showDormant
    setShowDormant(next)
    try { localStorage.setItem(SHOW_DORMANT_KEY, String(next)) } catch { /* */ }
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // Filter by search, then count dormant before building sections
  const q = search.trim().toLowerCase()
  const filtered = q
    ? rawProofs.filter((p: any) => {
        const name    = (p.contacts?.full_name      ?? '').toLowerCase()
        const company = (p.contacts?.companies?.name ?? '').toLowerCase()
        return name.includes(q) || company.includes(q)
      })
    : rawProofs

  const dormantCount = filtered.filter((p: any) => p.status === 'dormant').length

  const sections = buildSections(filtered, sort, showDormant)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Page header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Plasma Design</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Proofs</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/customers"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              Customers
            </Link>
            <Link
              to="/proofs/new"
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              New project
            </Link>
            <button
              onClick={handleSignOut}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* ── Loading ────────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
          </div>

        ) : rawProofs.length === 0 ? (
        /* ── Truly empty ───────────────────────────────────────────────────── */
          <div className="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No proofs yet.</p>
            <Link
              to="/proofs/new"
              className="mt-3 inline-block text-sm font-medium text-gray-900 underline"
            >
              Create the first one
            </Link>
          </div>

        ) : (
          <>
            {/* ── Recent projects (your own) ───────────────────────────────── */}
            {recent.length > 0 && (
              <div className="mb-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Recent projects</h2>
                <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                  {recent.map((r, i) => {
                    const locked = r.status === 'approved' || r.status === 'abandoned'
                    return (
                      <div
                        key={r.proofId}
                        onClick={() => navigate(`/proofs/${r.proofId}`)}
                        className={[
                          ROW_GRID,
                          'cursor-pointer px-5 py-3 hover:bg-gray-50',
                          i > 0 ? 'border-t border-gray-100' : '',
                        ].join(' ')}
                      >
                        {/* Customer + company */}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-gray-900">{r.customerName}</div>
                          {r.companyName && (
                            <div className="truncate text-xs text-gray-400">{r.companyName}</div>
                          )}
                        </div>
                        <span className="truncate text-sm text-gray-400">{r.materialDisplay}</span>
                        <StatusPill status={r.status} />
                        <span className="text-sm text-gray-400">{formatRelative(r.lastWorkedAt)}</span>
                        <PreviewLink proofId={r.proofId} />
                        {locked
                          ? <span />
                          : <AddVersionLink proofId={r.proofId} />}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── Toolbar ──────────────────────────────────────────────────── */}
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="search"
                placeholder="Search customer or company"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              />
              <div className="flex shrink-0 items-center gap-2">
                {dormantCount > 0 && (
                  <button
                    onClick={toggleShowDormant}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-gray-400 hover:text-gray-700"
                  >
                    {showDormant ? 'Hide dormant' : `Show dormant (${dormantCount})`}
                  </button>
                )}
                <div className="flex shrink-0 rounded-lg border border-gray-200 bg-white p-0.5">
                  {(['date', 'name'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => handleSortChange(mode)}
                      className={[
                        'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                        sort === mode
                          ? 'bg-gray-900 text-white'
                          : 'text-gray-500 hover:text-gray-900',
                      ].join(' ')}
                    >
                      {mode === 'date' ? 'Date' : 'Name'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Empty search ─────────────────────────────────────────────── */}
            {sections.length === 0 ? (
              <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
                <p className="text-gray-400">No proofs match "{search}"</p>
                <button
                  onClick={() => setSearch('')}
                  className="mt-2 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
                >
                  Clear search
                </button>
              </div>

            ) : (
            /* ── Company sections ──────────────────────────────────────────── */
              <div className="space-y-8">
                {sections.map((section) => (
                  <div key={section.companyKey}>

                    {/* Company header */}
                    <div className="mb-3 flex items-center gap-3">
                      <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-gray-500">
                        {section.companyName ?? 'No company'}
                      </span>
                      {section.companyKey !== '__individual__' && (
                        <Link
                          to={`/proofs/new?companyId=${section.companyKey}`}
                          title={`New proof for ${section.companyName}`}
                          aria-label={`New proof for ${section.companyName}`}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                        >
                          <PlusIcon />
                        </Link>
                      )}
                      <div className="flex-1 border-t border-gray-200" />
                    </div>

                    {/* Contacts + proofs card */}
                    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                      {section.contacts.map((cg, ci) => (
                        <div
                          key={cg.contactId}
                          className={ci > 0 ? 'border-t border-gray-100' : ''}
                        >
                          {/* Contact label */}
                          <div className="group flex items-center justify-between bg-gray-50/80 px-5 py-1">
                            <span className="text-sm font-medium text-gray-600">
                              {cg.contactName}
                            </span>
                            <Link
                              to={`/proofs/new?contactId=${cg.contactId}`}
                              title={`New proof for ${cg.contactName}`}
                              aria-label={`New proof for ${cg.contactName}`}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-gray-300 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                            >
                              <PlusIcon />
                            </Link>
                          </div>

                          {/* Proof rows */}
                          {cg.proofs.map((proof) => {
                            const canAddVersion = proof.status === 'in_progress' || proof.status === 'dormant'
                            return (
                              <div
                                key={proof.id}
                                onClick={() => navigate(`/proofs/${proof.id}`)}
                                className={[
                                  ROW_GRID,
                                  'cursor-pointer border-t border-gray-50 px-5 py-2.5 hover:bg-gray-50',
                                  proof.status === 'dormant' ? 'opacity-50' : '',
                                ].join(' ')}
                              >
                                <span className="truncate text-sm text-gray-400">
                                  {proof.current_version != null ? `v${proof.current_version}` : '—'}
                                </span>
                                <span className="truncate text-sm text-gray-400">
                                  {proof.material_display ?? '—'}
                                </span>
                                <StatusPill status={proof.status} />
                                <span className="text-sm text-gray-400">{formatRelative(proof.created_at)}</span>
                                <PreviewLink proofId={proof.id} />
                                {canAddVersion
                                  ? <AddVersionLink proofId={proof.id} />
                                  : <span />}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
