import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface ProofRow {
  id: string
  customer_name: string
  company: string | null
  created_at: string
  current_version: number | null
}

type SortMode = 'date' | 'name'

const SORT_KEY = 'proofViewer.dashboard.sort'

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'name' ? 'name' : 'date'
  } catch {
    return 'date'
  }
}

// ── Date grouping ─────────────────────────────────────────────────────────────

const DATE_GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Last week', 'Earlier this month']

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  // Monday of the current week (local timezone)
  const dow = today.getDay() // 0 = Sun, 1 = Mon, ...
  const daysToMonday = dow === 0 ? 6 : dow - 1
  const thisWeekStart = new Date(today)
  thisWeekStart.setDate(today.getDate() - daysToMonday)

  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(thisWeekStart.getDate() - 7)

  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1)

  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  if (date >= thisWeekStart) return 'This week'
  if (date >= lastWeekStart) return 'Last week'
  if (date >= thisMonthStart) return 'Earlier this month'
  // Older: "March 2026", "February 2026", …
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

// ── Name grouping ─────────────────────────────────────────────────────────────

function getNameGroup(name: string): string {
  const first = (name.trim()[0] ?? '').toUpperCase()
  return /[A-Z]/.test(first) ? first : '#'
}

// ── Group builder ─────────────────────────────────────────────────────────────

interface Group {
  label: string
  proofs: ProofRow[]
}

function buildGroups(proofs: ProofRow[], sort: SortMode): Group[] {
  if (sort === 'date') {
    const sorted = [...proofs].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    const map = new Map<string, ProofRow[]>()
    for (const p of sorted) {
      const label = getDateGroup(p.created_at)
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(p)
    }
    const result: Group[] = []
    for (const label of DATE_GROUP_ORDER) {
      if (map.has(label)) {
        result.push({ label, proofs: map.get(label)! })
        map.delete(label)
      }
    }
    // Remaining entries are month labels, in newest-first insertion order
    for (const [label, ps] of map) result.push({ label, proofs: ps })
    return result
  } else {
    const sorted = [...proofs].sort((a, b) =>
      a.customer_name.localeCompare(b.customer_name, 'en', { sensitivity: 'base' })
    )
    const map = new Map<string, ProofRow[]>()
    for (const p of sorted) {
      const label = getNameGroup(p.customer_name)
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(p)
    }
    const result: Group[] = []
    // Letter groups first (map insertion order is alphabetical since input is sorted)
    for (const [label, ps] of map) {
      if (label !== '#') result.push({ label, proofs: ps })
    }
    // Numeric / symbol names at the end
    if (map.has('#')) result.push({ label: '#', proofs: map.get('#')! })
    return result
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate()
  const [proofs, setProofs] = useState<ProofRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>(readSort)

  useEffect(() => {
    loadProofs()
  }, [])

  async function loadProofs() {
    const { data } = await supabase
      .from('proofs')
      .select('id, customer_name, company, created_at, proof_versions(version_number, is_current)')
      .order('created_at', { ascending: false })

    const rows = (data ?? []).map((p: any) => ({
      id: p.id,
      customer_name: p.customer_name,
      company: p.company,
      created_at: p.created_at,
      current_version: p.proof_versions?.find((v: any) => v.is_current)?.version_number ?? null,
    }))

    setProofs(rows)
    setLoading(false)
  }

  function handleSortChange(s: SortMode) {
    setSort(s)
    try { localStorage.setItem(SORT_KEY, s) } catch { /* storage may be unavailable */ }
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // Filter before grouping
  const q = search.trim().toLowerCase()
  const filtered = q
    ? proofs.filter(
        (p) =>
          p.customer_name.toLowerCase().includes(q) ||
          (p.company?.toLowerCase().includes(q) ?? false)
      )
    : proofs

  const groups = buildGroups(filtered, sort)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Plasma Design</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Proofs</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/proofs/new"
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              New proof
            </Link>
            <button
              onClick={handleSignOut}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
          </div>
        ) : proofs.length === 0 ? (
          <div className="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No proofs yet.</p>
            <Link to="/proofs/new" className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
              Create the first one
            </Link>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="search"
                placeholder="Search customer or company"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              />
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

            {/* Empty search state */}
            {groups.length === 0 ? (
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
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Customer</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Company</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Current version</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Created</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Customer link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <Fragment key={group.label}>
                        {/* Group header row */}
                        <tr>
                          <td colSpan={5} className="px-6 pb-1.5 pt-5">
                            <div className="flex items-center gap-3">
                              <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-gray-400">
                                {group.label}
                              </span>
                              <div className="flex-1 border-t border-gray-100" />
                            </div>
                          </td>
                        </tr>
                        {/* Data rows */}
                        {group.proofs.map((proof) => (
                          <tr key={proof.id} className="border-t border-gray-50 hover:bg-gray-50">
                            <td className="px-6 py-3.5">
                              <Link
                                to={`/proofs/${proof.id}`}
                                className="font-medium text-gray-900 hover:underline"
                              >
                                {proof.customer_name}
                              </Link>
                            </td>
                            <td className="px-6 py-3.5 text-gray-500">{proof.company ?? '—'}</td>
                            <td className="px-6 py-3.5 text-gray-500">
                              {proof.current_version != null ? `v${proof.current_version}` : '—'}
                            </td>
                            <td className="px-6 py-3.5 text-gray-500">
                              {new Date(proof.created_at).toLocaleDateString('en-GB')}
                            </td>
                            <td className="px-6 py-3.5">
                              <a
                                href={`/p/${proof.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-400 hover:text-gray-900"
                              >
                                /p/{proof.id.slice(0, 8)}…
                              </a>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
