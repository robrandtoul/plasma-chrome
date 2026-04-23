import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { ProofStatus } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  computeViewedState,
  viewedStateDotClass,
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'
import { designerPreviewPath } from '../lib/customerProofUrl'

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

interface ProofItem {
  id: string
  lastActivityAt: string
  current_version: number | null
  material_display: string | null
  status: ProofStatus
  viewedState: ViewedState
  lastViewedAt: string | null
  // Customer's disclaimer acknowledgement timestamp (migration
  // 000091). Null until the customer ticks the "I've read this"
  // box on the proof page. Surfaced in the row subtitle as a
  // "· Acked {relativeTime}" tail, but only while the proof is
  // still in_progress — once approved the ack is implied and
  // the tail becomes noise.
  disclaimerAckedAt: string | null
}

interface RecentProject {
  proofId: string
  customerName: string
  companyName: string | null
  materialDisplay: string
  status: ProofStatus
  lastWorkedAt: string
  viewedState: ViewedState
  lastViewedAt: string | null
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

function buildSections(
  rawProofs: any[],
  sort: SortMode,
  showDormant: boolean,
  viewedByProofId: Map<string, { state: ViewedState; lastViewedAt: string | null }>,
): CompanySection[] {
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

    // last_activity_at is bumped by a trigger whenever a version is added;
    // fall back to the proof's creation time for shell rows that predate the
    // trigger or have no versions yet.
    const lastActivityAt: string = p.last_activity_at ?? p.created_at

    if (!map.has(companyKey)) {
      map.set(companyKey, {
        companyKey,
        companyName,
        latestProofDate: lastActivityAt,
        contacts: [],
      })
    }

    const section = map.get(companyKey)!
    if (lastActivityAt > section.latestProofDate) {
      section.latestProofDate = lastActivityAt
    }

    let cg = section.contacts.find((c) => c.contactId === contactId)
    if (!cg) {
      cg = { contactId, contactName, proofs: [] }
      section.contacts.push(cg)
    }

    const versions = (p.proof_versions ?? []) as any[]
    const current  = versions.find((v) => v.is_current)
    const viewed = viewedByProofId.get(p.id) ?? { state: 'unviewed' as ViewedState, lastViewedAt: null }
    cg.proofs.push({
      id: p.id,
      lastActivityAt,
      current_version:  current?.version_number   ?? null,
      material_display: current?.material_display ?? null,
      status,
      viewedState: viewed.state,
      lastViewedAt: viewed.lastViewedAt,
      disclaimerAckedAt: p.disclaimer_acknowledged_at ?? null,
    })
  }

  // Sort internals: active proofs newest-first (by last activity), dormant after
  for (const section of map.values()) {
    for (const cg of section.contacts) {
      cg.proofs.sort((a, b) => {
        const aDormant = a.status === 'dormant' ? 1 : 0
        const bDormant = b.status === 'dormant' ? 1 : 0
        if (aDormant !== bDormant) return aDormant - bDormant
        return b.lastActivityAt.localeCompare(a.lastActivityAt)
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
//
// Responsive: below sm: (iOS portrait etc.) the 6-track desktop template
// demands ~580px which busts a 390px viewport, collapsing the 1fr track
// to 0 and clipping the customer block. Mobile gets a 3-track cut —
// customer / material / status — with narrower fixed widths. Date,
// Preview, and Add version are hidden via `hidden sm:block` on each of
// those three trailing cells at each render site, so they drop out of
// the grid entirely on mobile rather than wrapping into a second row.
const ROW_GRID = 'grid items-center gap-3 grid-cols-[minmax(0,1fr)_5.5rem_6.5rem] sm:grid-cols-[minmax(0,1fr)_8rem_7rem_5.5rem_5.5rem_6.5rem]'

// ── Recent projects ───────────────────────────────────────────────────────────

function buildRecent(
  versions: any[],
  viewedByProofId: Map<string, { state: ViewedState; lastViewedAt: string | null }>,
): RecentProject[] {
  const seen = new Set<string>()
  const out: RecentProject[] = []
  for (const v of versions) {
    if (seen.has(v.proof_id)) continue
    seen.add(v.proof_id)
    const viewed = viewedByProofId.get(v.proof_id) ?? { state: 'unviewed' as ViewedState, lastViewedAt: null }
    out.push({
      proofId: v.proof_id,
      customerName: v.proofs?.contacts?.full_name ?? '',
      companyName: v.proofs?.contacts?.companies?.name ?? null,
      materialDisplay: v.material_display ?? '—',
      status: (v.proofs?.status ?? 'in_progress') as ProofStatus,
      // Show the project's last activity (any user), not the version's
      // own creation timestamp, so both views on the page agree on the
      // date.
      lastWorkedAt: v.proofs?.last_activity_at ?? v.created_at,
      viewedState: viewed.state,
      lastViewedAt: viewed.lastViewedAt,
    })
    if (out.length >= 10) break
  }
  return out
}

function StatusPill({ status }: { status: ProofStatus }) {
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

// Small solid circle that communicates a project's viewed state at
// a glance. Title fires on hover as a plain browser tooltip so
// screen-readers + keyboard users still hit the same info without a
// richer popover layer.
function ViewedDot({ state }: { state: ViewedState }) {
  return (
    <span
      aria-label={viewedStateTitle(state)}
      title={viewedStateTitle(state)}
      className={[
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        viewedStateDotClass(state),
      ].join(' ')}
    />
  )
}

function PreviewLink({ proofId, hasVersions }: { proofId: string; hasVersions: boolean }) {
  if (!hasVersions) {
    // Disabled rendering: keep the button visible so the affordance
    // is discoverable, but strip the link so it can't open the
    // near-blank customer page. Tooltip teaches the unlock.
    return (
      <span
        onClick={(e) => e.stopPropagation()}
        title="Add a version to enable preview"
        aria-disabled="true"
        className="w-fit shrink-0 cursor-not-allowed rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 ring-1 ring-gray-100"
      >
        Preview
      </span>
    )
  }
  return (
    <a
      // Designer preview — suppresses the record_proof_view RPC
      // on the customer page so dashboard clicks don't pollute
      // the viewed indicator. Same flag as ProofDetailPage's
      // "Preview as customer" iframe; both go through the shared
      // helper so the mechanism stays in one place.
      href={designerPreviewPath(proofId)}
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
  const { role } = useAuth()
  const [rawProofs, setRawProofs]       = useState<any[]>([])
  const [recent, setRecent]             = useState<RecentProject[]>([])
  const [viewedByProofId, setViewedByProofId] = useState<Map<string, { state: ViewedState; lastViewedAt: string | null }>>(new Map())
  const [loading, setLoading]           = useState(true)
  const [search, setSearch]             = useState('')
  const [sort, setSort]                 = useState<SortMode>(readSort)
  const [showDormant, setShowDormant]   = useState(readShowDormant)

  useEffect(() => { loadProofs() }, [])

  async function loadProofs() {
    const proofsPromise = supabase
      .from('proofs')
      .select(
        'id, created_at, last_activity_at, status, disclaimer_acknowledged_at,' +
        // email is pulled for search only — not rendered on the
        // project cards. Keeps the search predicate below able to
        // match against it without another round-trip.
        'contacts(id, full_name, email, companies(id, name)),' +
        'proof_versions(id, version_number, is_current, material_display)'
      )
      .order('last_activity_at', { ascending: false, nullsFirst: false })

    // Recent projects across the whole team. Designers share a Help
    // Scout inbox and collaborate on projects (one ships v1, another
    // ships v2), so a per-designer feed would hide half the work.
    // We pull the 50 latest versions by anyone, then dedupe by
    // proof_id client-side so each project appears once, capped at
    // 10 rows. The displayed date comes from proofs.last_activity_at
    // (not the version's own timestamp) so both sections on this
    // page agree on the date.
    const recentPromise = supabase
      .from('proof_versions')
      .select(
        'proof_id, created_at, material_display,' +
        'proofs!inner(status, last_activity_at, contacts(full_name, companies(name)))'
      )
      .order('created_at', { ascending: false })
      .limit(50)

    const [{ data: proofs }, { data: versions }] = await Promise.all([proofsPromise, recentPromise])

    // Load real (non-bot) views for every version we just pulled.
    // One query, then aggregate per version in JS. Designers
    // almost always have far fewer versions than the 1k row cap.
    const proofsList = (proofs ?? []) as any[]
    const allVersionIds: string[] = []
    for (const p of proofsList) {
      for (const v of (p.proof_versions ?? [])) {
        if (v?.id) allVersionIds.push(v.id)
      }
    }

    const viewsByVersionId = new Map<string, string>() // versionId → latest viewed_at
    if (allVersionIds.length > 0) {
      const { data: viewRows } = await supabase
        .from('proof_version_views')
        .select('proof_version_id, viewed_at')
        .eq('is_bot', false)
        .in('proof_version_id', allVersionIds)
        .order('viewed_at', { ascending: false })
      for (const r of (viewRows ?? []) as any[]) {
        if (!viewsByVersionId.has(r.proof_version_id)) {
          viewsByVersionId.set(r.proof_version_id, r.viewed_at)
        }
      }
    }

    // Precompute per-project state + latest view so both the grouped
    // list and the Recent projects row can read from one source.
    const viewedByProofId = new Map<string, { state: ViewedState; lastViewedAt: string | null }>()
    for (const p of proofsList) {
      const vs = (p.proof_versions ?? []) as any[]
      const currentVersionId = vs.find((v) => v.is_current)?.id ?? null
      const viewedSet = new Set<string>()
      let latest: string | null = null
      for (const v of vs) {
        const at = viewsByVersionId.get(v.id)
        if (at) {
          viewedSet.add(v.id)
          if (!latest || at > latest) latest = at
        }
      }
      const state = computeViewedState({ currentVersionId, viewedVersionIds: viewedSet })
      // Prefer the current version's own view time if it's been
      // viewed; otherwise the latest view across all versions.
      const currentViewedAt = currentVersionId ? viewsByVersionId.get(currentVersionId) ?? null : null
      viewedByProofId.set(p.id, {
        state,
        lastViewedAt: state === 'viewed_current' ? currentViewedAt : latest,
      })
    }

    setRawProofs(proofs ?? [])
    setViewedByProofId(viewedByProofId)
    setRecent(buildRecent((versions ?? []) as any[], viewedByProofId))
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

  // Filter by search, then count dormant before building sections.
  // Substring + case-insensitive across three fields: customer
  // name, company, and email. Email is search-only — cards don't
  // render it — but matching against it helps when the designer
  // remembers the Help Scout thread before the contact name.
  // Missing values (null company, contact with no email) fall
  // back to '' so the includes check is safe.
  const q = search.trim().toLowerCase()
  const filtered = q
    ? rawProofs.filter((p: any) => {
        const name    = (p.contacts?.full_name      ?? '').toLowerCase()
        const company = (p.contacts?.companies?.name ?? '').toLowerCase()
        const email   = (p.contacts?.email           ?? '').toLowerCase()
        return name.includes(q) || company.includes(q) || email.includes(q)
      })
    : rawProofs

  const dormantCount = filtered.filter((p: any) => p.status === 'dormant').length

  const sections = buildSections(filtered, sort, showDormant, viewedByProofId)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Page header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">PlasmaDesign</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Projects</h1>
          </div>
          <div className="flex items-center gap-3">
            {role === 'admin' && (
              <Link
                to="/admin/users"
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
              >
                Admin
              </Link>
            )}
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
            <p className="text-gray-400">No projects yet.</p>
            <Link
              to="/proofs/new"
              className="mt-3 inline-block text-sm font-medium text-gray-900 underline"
            >
              Create the first one
            </Link>
          </div>

        ) : (
          <>
            {/* ── Legend ──────────────────────────────────────────────────────
                Persistent caption explaining the viewed-state dots that
                appear at the left edge of every project row. Renders the
                real ViewedDot component rather than re-implementing the
                styling, so the legend can never drift from the actual
                indicators. The dot+text pairs are self-describing, so no
                row label is needed. Only appears when there's content to
                explain — hidden on the empty state and during the initial
                load. */}
            <div className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5"><ViewedDot state="unviewed" />Not viewed</span>
              <span className="inline-flex items-center gap-1.5"><ViewedDot state="viewed_current" />Current version viewed</span>
              <span className="inline-flex items-center gap-1.5"><ViewedDot state="viewed_stale" />Older version viewed</span>
            </div>

            {/* ── Recent projects (team-wide) ──────────────────────────────── */}
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
                        {/* Customer + company, plus viewed-state dot + "Viewed Xh ago" tail */}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <ViewedDot state={r.viewedState} />
                            <span className="truncate text-sm font-medium text-gray-900">{r.customerName}</span>
                          </div>
                          {(r.companyName || (r.viewedState !== 'unviewed' && r.lastViewedAt)) && (
                            <div className="truncate text-xs text-gray-400">
                              {r.companyName}
                              {r.companyName && r.viewedState !== 'unviewed' && r.lastViewedAt ? ' · ' : ''}
                              {r.viewedState !== 'unviewed' && r.lastViewedAt && (
                                <span title={formatAbsoluteDateTime(r.lastViewedAt)}>
                                  Viewed {relativeTime(r.lastViewedAt)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="truncate text-sm text-gray-400">{r.materialDisplay}</span>
                        <StatusPill status={r.status} />
                        <span className="hidden text-sm text-gray-400 sm:block">{formatRelative(r.lastWorkedAt)}</span>
                        {/* Recent list is built from proof_versions, so every row here has at least one version. */}
                        <div className="hidden sm:block">
                          <PreviewLink proofId={r.proofId} hasVersions />
                        </div>
                        {locked
                          ? <span className="hidden sm:block" />
                          : <div className="hidden sm:block"><AddVersionLink proofId={r.proofId} /></div>}
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
                placeholder="Search customer, company, or email"
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
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-gray-400">Sort:</span>
                  <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
                    {(['date', 'name'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => handleSortChange(mode)}
                        className={[
                          'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                          sort === mode
                            ? 'bg-gray-100 text-gray-900'
                            : 'text-gray-500 hover:text-gray-900',
                        ].join(' ')}
                      >
                        {mode === 'date' ? 'Date' : 'Name'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Empty search ─────────────────────────────────────────────── */}
            {sections.length === 0 ? (
              <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
                <p className="text-gray-400">No projects match "{search}"</p>
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
                          title={`New project for ${section.companyName}`}
                          aria-label={`New project for ${section.companyName}`}
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
                              title={`New project for ${cg.contactName}`}
                              aria-label={`New project for ${cg.contactName}`}
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
                                <span className="flex items-center gap-1.5 truncate text-sm text-gray-400">
                                  <ViewedDot state={proof.viewedState} />
                                  <span className="truncate">
                                    {proof.current_version != null ? `v${proof.current_version}` : '—'}
                                    {proof.viewedState !== 'unviewed' && proof.lastViewedAt && (
                                      <span className="ml-1 text-[11px]" title={formatAbsoluteDateTime(proof.lastViewedAt)}>· Viewed {relativeTime(proof.lastViewedAt)}</span>
                                    )}
                                    {/* Disclaimer ack tail — only surfaced while
                                        the proof is still in_progress. Once
                                        approved the ack is implied by the
                                        approval itself; abandoned / dormant
                                        rows drop it too to keep the tail
                                        focused on active work. */}
                                    {proof.status === 'in_progress' && proof.disclaimerAckedAt && (
                                      <span className="ml-1 text-[11px]" title={formatAbsoluteDateTime(proof.disclaimerAckedAt)}>· Acked {relativeTime(proof.disclaimerAckedAt)}</span>
                                    )}
                                  </span>
                                </span>
                                <span className="truncate text-sm text-gray-400">
                                  {proof.material_display ?? '—'}
                                </span>
                                <StatusPill status={proof.status} />
                                <span className="hidden text-sm text-gray-400 sm:block">{formatRelative(proof.lastActivityAt)}</span>
                                <div className="hidden sm:block">
                                  <PreviewLink proofId={proof.id} hasVersions={proof.current_version != null} />
                                </div>
                                {canAddVersion
                                  ? <div className="hidden sm:block"><AddVersionLink proofId={proof.id} /></div>
                                  : <span className="hidden sm:block" />}
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
