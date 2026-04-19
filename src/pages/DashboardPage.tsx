import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface ProofItem {
  id: string
  created_at: string
  current_version: number | null
  material_display: string | null
  status: 'in_progress' | 'approved'
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

function buildSections(rawProofs: any[], sort: SortMode): CompanySection[] {
  const map = new Map<string, CompanySection>()

  for (const p of rawProofs) {
    const contact   = p.contacts   as any
    const company   = contact?.companies as any
    const companyKey  = company?.id   ?? '__individual__'
    const companyName: string | null = company?.name ?? null
    const contactId   = contact?.id   ?? ''
    const contactName = contact?.full_name ?? ''

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
      status: p.status ?? 'in_progress',
    })
  }

  // Sort internals: proofs newest-first, contacts alphabetically
  for (const section of map.values()) {
    for (const cg of section.contacts) {
      cg.proofs.sort((a, b) => b.created_at.localeCompare(a.created_at))
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate()
  const [rawProofs, setRawProofs] = useState<any[]>([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [sort, setSort]           = useState<SortMode>(readSort)

  useEffect(() => { loadProofs() }, [])

  async function loadProofs() {
    const { data } = await supabase
      .from('proofs')
      .select(
        'id, created_at, status,' +
        'contacts(id, full_name, companies(id, name)),' +
        'proof_versions(version_number, is_current, material_display)'
      )
      .order('created_at', { ascending: false })

    setRawProofs(data ?? [])
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

  // Filter before building sections
  const q = search.trim().toLowerCase()
  const filtered = q
    ? rawProofs.filter((p: any) => {
        const name    = (p.contacts?.full_name     ?? '').toLowerCase()
        const company = (p.contacts?.companies?.name ?? '').toLowerCase()
        return name.includes(q) || company.includes(q)
      })
    : rawProofs

  const sections = buildSections(filtered, sort)

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
            {/* ── Toolbar ──────────────────────────────────────────────────── */}
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
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
                          <div className="bg-gray-50/80 px-5 py-2.5">
                            <span className="text-sm font-medium text-gray-600">
                              {cg.contactName}
                            </span>
                          </div>

                          {/* Proof rows */}
                          {cg.proofs.map((proof) => (
                            <div
                              key={proof.id}
                              onClick={() => navigate(`/proofs/${proof.id}`)}
                              className="flex cursor-pointer items-center gap-4 border-t border-gray-50 px-5 py-2.5 hover:bg-gray-50"
                            >
                              {/* Version */}
                              <span className="w-8 shrink-0 text-sm text-gray-400">
                                {proof.current_version != null ? `v${proof.current_version}` : '—'}
                              </span>
                              {/* Material */}
                              <span className="flex-1 truncate text-sm text-gray-400">
                                {proof.material_display ?? '—'}
                              </span>
                              {/* Date */}
                              <span className="shrink-0 text-sm tabular-nums text-gray-400">
                                {new Date(proof.created_at).toLocaleDateString('en-GB')}
                              </span>
                              {/* Status pill */}
                              {proof.status === 'approved' ? (
                                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                  Approved
                                </span>
                              ) : (
                                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                  In progress
                                </span>
                              )}
                              {/* Customer link — stopPropagation so the row click doesn't also fire */}
                              <a
                                href={`/p/${proof.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="shrink-0 text-xs text-gray-300 hover:text-gray-600"
                              >
                                /p/{proof.id.slice(0, 8)}…
                              </a>
                            </div>
                          ))}
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
