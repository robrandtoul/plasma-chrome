import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { relativeTime } from '../lib/relativeTime'
import type { ProofStatus } from '../lib/types'
import Modal from '../components/Modal'

interface ContactRow {
  id: string
  full_name: string
  email: string
  created_at: string
  company_id: string | null
  proofCount: number
}

interface CompanyRow {
  id: string
  name: string
  created_at: string
  contacts: ContactRow[]
  proofCount: number
}

interface ProjectLite {
  proof_id: string
  status: ProofStatus
  contact_id: string | null
  contact_name: string | null
  company_id: string | null
  company_name: string | null
  current_version_number: number | null
  material_display: string | null
  last_activity_at: string | null
}

type Pending =
  | { kind: 'contact'; id: string; label: string }
  | { kind: 'company'; id: string; name: string; contactCount: number }

type SortMode = 'alpha' | 'newest' | 'oldest'

interface CompanyEdit {
  draftName: string
  saving: boolean
  rowError: string | null
}

interface ContactEdit {
  draftFullName: string
  draftEmail: string
  draftCompanyId: string | null // null = "No company"
  saving: boolean
  rowError: string | null
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function CustomersPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [orphans, setOrphans] = useState<ContactRow[]>([])
  const [projectsByCompany, setProjectsByCompany] = useState<Map<string, ProjectLite[]>>(new Map())
  const [projectsByContact, setProjectsByContact] = useState<Map<string, ProjectLite[]>>(new Map())
  // `expandedCompanies` controls whether a company's CONTACTS panel is
  // open. Defaults to empty — everything collapses to one row per
  // company on load. Pulling a search query auto-expands every visible
  // company (computed below) so contact matches are findable without a
  // click.
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set())
  // `companyProjectsOpen` controls the separate "show projects under
  // this company" panel triggered by the count chip. Independent of
  // contact-expansion: a designer can have just the project list open,
  // just the contacts, or both.
  const [companyProjectsOpen, setCompanyProjectsOpen] = useState<Set<string>>(new Set())
  const [expandedContacts, setExpandedContacts] = useState<Set<string>>(new Set())
  // "No company" group collapse state. Single boolean since there's
  // only one such section.
  const [orphansExpanded, setOrphansExpanded] = useState<boolean>(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [working, setWorking] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Controls
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('alpha')

  // Per-row inline-edit state. Absent key = read-only row.
  const [editingCompany, setEditingCompany] = useState<Record<string, CompanyEdit>>({})
  const [editingContact, setEditingContact] = useState<Record<string, ContactEdit>>({})

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    // We pull the proof rows with their version count so we can ignore
    // "shell" proofs (row exists but no version has been added). Those
    // are cleaned up on delete by the RPC anyway.
    //
    // The projects pull from `public_dashboard_projects` feeds the
    // click-to-expand lists on each company / contact badge. It's the
    // same view the dashboard reads, so a project's row is one fetch
    // away and already shaped the way the row UI wants.
    const [companiesResult, orphanResult, projectsResult] = await Promise.all([
      supabase
        .from('companies')
        .select('id, name, created_at, contacts(id, full_name, email, created_at, company_id, proofs(id, proof_versions(count)))')
        .order('name'),
      supabase
        .from('contacts')
        .select('id, full_name, email, created_at, company_id, proofs(id, proof_versions(count))')
        .is('company_id', null)
        .order('full_name'),
      supabase
        .from('public_dashboard_projects')
        .select('proof_id, status, contact_id, contact_name, company_id, company_name, current_version_number, material_display, last_activity_at')
        .order('last_activity_at', { ascending: false, nullsFirst: false })
        .limit(2000),
    ])

    function countRealProofs(proofs: any[]): number {
      return proofs.filter((p) => (p.proof_versions?.[0]?.count ?? 0) > 0).length
    }

    const rawCompanies = (companiesResult.data ?? []) as any[]
    const compRows: CompanyRow[] = rawCompanies.map((c) => {
      const contacts: ContactRow[] = ((c.contacts ?? []) as any[]).map((k) => ({
        id: k.id,
        full_name: k.full_name,
        email: k.email,
        created_at: k.created_at,
        company_id: k.company_id,
        proofCount: countRealProofs(k.proofs ?? []),
      }))
      contacts.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' }))
      return {
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        contacts,
        proofCount: contacts.reduce((sum, k) => sum + k.proofCount, 0),
      }
    })

    const rawOrphans = (orphanResult.data ?? []) as any[]
    const orphanRows: ContactRow[] = rawOrphans.map((k) => ({
      id: k.id,
      full_name: k.full_name,
      email: k.email,
      created_at: k.created_at,
      company_id: k.company_id,
      proofCount: countRealProofs(k.proofs ?? []),
    }))

    // Group projects by contact_id and company_id for fast lookup when a
    // designer toggles a badge. Filtering proof_versions(count) > 0 here
    // matches the shell-proof exclusion above; the dashboard view only
    // emits proofs that have at least one version anyway, but we still
    // skip rows missing a contact_id (legacy shell rows can theoretically
    // exist) to keep the maps tidy.
    const rawProjects = (projectsResult.data ?? []) as ProjectLite[]
    const byCompany = new Map<string, ProjectLite[]>()
    const byContact = new Map<string, ProjectLite[]>()
    for (const p of rawProjects) {
      if (p.contact_id) {
        const arr = byContact.get(p.contact_id) ?? []
        arr.push(p)
        byContact.set(p.contact_id, arr)
      }
      if (p.company_id) {
        const arr = byCompany.get(p.company_id) ?? []
        arr.push(p)
        byCompany.set(p.company_id, arr)
      }
    }

    setCompanies(compRows)
    setOrphans(orphanRows)
    setProjectsByCompany(byCompany)
    setProjectsByContact(byContact)
    setLoading(false)
  }

  function toggleCompanyExpanded(id: string) {
    setExpandedCompanies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCompanyProjects(id: string) {
    setCompanyProjectsOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleContactExpanded(id: string) {
    setExpandedContacts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function showToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleConfirm() {
    if (!pending) return
    setWorking(true)
    setErrorMsg(null)
    try {
      if (pending.kind === 'contact') {
        const { error } = await supabase.rpc('delete_contact_if_empty', { p_contact_id: pending.id })
        if (error) throw new Error(error.message)
        void logAudit({
          action: 'contact.deleted',
          targetType: 'contact',
          targetId: pending.id,
          targetLabel: pending.label,
        })
        showToast(`Deleted ${pending.label}`)
      } else {
        const { error } = await supabase.rpc('delete_company_if_empty', { p_company_id: pending.id })
        if (error) throw new Error(error.message)
        void logAudit({
          action: 'company.deleted',
          targetType: 'company',
          targetId: pending.id,
          targetLabel: pending.name,
          metadata: { cascaded_contacts: pending.contactCount },
        })
        showToast(`Deleted ${pending.name}`)
      }
      setPending(null)
      await load()
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  // ── Company edit handlers ──────────────────────────────────────────────────

  function startEditCompany(c: CompanyRow) {
    setEditingCompany((prev) => ({
      ...prev,
      [c.id]: { draftName: c.name, saving: false, rowError: null },
    }))
  }

  function cancelEditCompany(id: string) {
    setEditingCompany((prev) => {
      const { [id]: _, ...rest } = prev
      return rest
    })
  }

  function setCompanyDraft(id: string, draftName: string) {
    setEditingCompany((prev) => ({
      ...prev,
      [id]: { ...prev[id], draftName, rowError: null },
    }))
  }

  async function saveCompany(c: CompanyRow) {
    const draft = editingCompany[c.id]
    if (!draft) return
    const trimmed = draft.draftName.trim()
    if (!trimmed) {
      setEditingCompany((prev) => ({ ...prev, [c.id]: { ...draft, rowError: 'Name is required.' } }))
      return
    }
    if (trimmed === c.name) {
      // No-op rename — just close the editor.
      cancelEditCompany(c.id)
      return
    }
    // Client-side case-insensitive uniqueness check; DB unique index on
    // lower(name) is the belt-and-braces.
    const conflict = companies.find(
      (other) => other.id !== c.id && other.name.toLowerCase() === trimmed.toLowerCase(),
    )
    if (conflict) {
      setEditingCompany((prev) => ({
        ...prev,
        [c.id]: { ...draft, rowError: `A company called "${conflict.name}" already exists.` },
      }))
      return
    }

    setEditingCompany((prev) => ({ ...prev, [c.id]: { ...draft, saving: true, rowError: null } }))

    const { data, error } = await supabase
      .from('companies')
      .update({ name: trimmed })
      .eq('id', c.id)
      .select('id, name')
      .single()

    if (error || !data) {
      const friendly = (error as any)?.code === '23505'
        ? `A company called "${trimmed}" already exists.`
        : error?.message ?? 'Save failed.'
      setEditingCompany((prev) => ({ ...prev, [c.id]: { ...draft, saving: false, rowError: friendly } }))
      return
    }

    setCompanies((prev) => prev.map((row) => (row.id === c.id ? { ...row, name: data.name } : row)))
    cancelEditCompany(c.id)
    void logAudit({
      action: 'company.updated',
      targetType: 'company',
      targetId: c.id,
      targetLabel: data.name,
      beforeValue: { name: c.name },
      afterValue: { name: data.name },
    })
  }

  // ── Contact edit handlers ──────────────────────────────────────────────────

  function startEditContact(k: ContactRow) {
    setEditingContact((prev) => ({
      ...prev,
      [k.id]: {
        draftFullName: k.full_name,
        draftEmail: k.email,
        draftCompanyId: k.company_id,
        saving: false,
        rowError: null,
      },
    }))
  }

  function cancelEditContact(id: string) {
    setEditingContact((prev) => {
      const { [id]: _, ...rest } = prev
      return rest
    })
  }

  function setContactDraft(id: string, patch: Partial<ContactEdit>) {
    setEditingContact((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch, rowError: null },
    }))
  }

  async function saveContact(k: ContactRow) {
    const draft = editingContact[k.id]
    if (!draft) return
    const trimmedName = draft.draftFullName.trim()
    const trimmedEmail = draft.draftEmail.trim()
    if (!trimmedName) {
      setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, rowError: 'Name is required.' } }))
      return
    }
    if (!trimmedEmail) {
      setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, rowError: 'Email is required.' } }))
      return
    }
    if (!EMAIL_SHAPE.test(trimmedEmail)) {
      setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, rowError: 'Email looks malformed.' } }))
      return
    }

    const after = {
      full_name: trimmedName,
      email: trimmedEmail,
      company_id: draft.draftCompanyId,
    }
    const before = {
      full_name: k.full_name,
      email: k.email,
      company_id: k.company_id,
    }

    // No-op? Just close.
    if (
      before.full_name === after.full_name &&
      before.email === after.email &&
      before.company_id === after.company_id
    ) {
      cancelEditContact(k.id)
      return
    }

    setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, saving: true, rowError: null } }))

    const { data, error } = await supabase
      .from('contacts')
      .update(after)
      .eq('id', k.id)
      .select('id, full_name, email, company_id, created_at')
      .single()

    if (error || !data) {
      const friendly = (error as any)?.code === '23505'
        ? 'Another contact in that company already uses this email.'
        : error?.message ?? 'Save failed.'
      setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, saving: false, rowError: friendly } }))
      return
    }

    void logAudit({
      action: 'contact.updated',
      targetType: 'contact',
      targetId: k.id,
      targetLabel: data.full_name,
      beforeValue: before,
      afterValue: after,
    })

    // The contact may have moved between sections. Simplest correct path
    // is a full reload — it rebuilds groupings without bespoke move logic.
    cancelEditContact(k.id)
    await load()
  }

  // ── Filter + sort pipeline ────────────────────────────────────────────────

  const { visibleCompanies, visibleOrphans } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const matchContact = (k: ContactRow) =>
      k.full_name.toLowerCase().includes(q) || k.email.toLowerCase().includes(q)

    let comps: CompanyRow[]
    let orphs: ContactRow[]

    if (!q) {
      comps = companies
      orphs = orphans
    } else {
      comps = companies
        .map((c) => {
          const nameHit = c.name.toLowerCase().includes(q)
          if (nameHit) return c // show all contacts under a name match
          const matchingContacts = c.contacts.filter(matchContact)
          if (matchingContacts.length === 0) return null
          return { ...c, contacts: matchingContacts }
        })
        .filter((c): c is CompanyRow => c !== null)
      orphs = orphans.filter(matchContact)
    }

    const sortComp = (a: CompanyRow, b: CompanyRow) => {
      if (sortMode === 'alpha') return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      if (sortMode === 'newest') return b.created_at.localeCompare(a.created_at)
      return a.created_at.localeCompare(b.created_at) // oldest
    }
    const sortContact = (a: ContactRow, b: ContactRow) => {
      if (sortMode === 'alpha') return a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' })
      if (sortMode === 'newest') return b.created_at.localeCompare(a.created_at)
      return a.created_at.localeCompare(b.created_at)
    }

    return {
      visibleCompanies: [...comps].sort(sortComp),
      visibleOrphans: [...orphs].sort(sortContact),
    }
  }, [companies, orphans, searchQuery, sortMode])

  const hasResults = visibleCompanies.length > 0 || visibleOrphans.length > 0
  const searching = searchQuery.trim().length > 0

  return (
    // Rendered as an Outlet child of AdminLayout (see App.tsx: the
    // route is /admin/customers). AdminLayout owns the page chrome —
    // the PlasmaDesign strip, the Admin heading, the tab nav, the
    // max-w-5xl content wrapper, the gray background. This component
    // returns just the page body, matching the shape of
    // AdminUsersPage / AdminPricingPage / AdminSettingsPage.
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900">Customers</h2>
        <p className="mt-1 text-sm text-gray-500">
          View, rename, and tidy up companies and contacts. You can only delete entries with no projects attached.
        </p>
      </div>

      {/* Controls — search + sort. Mirrors the dashboard's list-card
          controls so the page feels of-a-piece with the rest of admin. */}
      <div className="mb-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200">
        <input
          type="search"
          placeholder="Search by company, contact, or email"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <div className="mt-3 flex items-center gap-2">
          <SelectField
            label="Sort"
            value={sortMode}
            onChange={(v) => setSortMode(v)}
            options={[
              { value: 'alpha', label: 'Alphabetical' },
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
            ]}
          />
        </div>
      </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
          </div>
        ) : (
          <div className="space-y-4">
            {visibleCompanies.map((c) => {
              const canDeleteCompany = c.proofCount === 0
              const edit = editingCompany[c.id]
              // A live search auto-expands every visible company so a
              // contact-only match isn't hidden behind a click. Edit
              // mode also forces open so the contacts panel doesn't
              // pop closed while the designer is mid-rename.
              const contactsOpen = searching || !!edit || expandedCompanies.has(c.id)
              return (
                <section key={c.id}>
                  <div className="mb-3 flex items-center gap-3">
                    {edit ? (
                      <>
                        <input
                          type="text"
                          value={edit.draftName}
                          onChange={(e) => setCompanyDraft(c.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveCompany(c)
                            if (e.key === 'Escape') cancelEditCompany(c.id)
                          }}
                          autoFocus
                          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                          aria-label="Company name"
                          disabled={edit.saving}
                        />
                        <button
                          onClick={() => void saveCompany(c)}
                          disabled={edit.saving}
                          className="shrink-0 rounded-md bg-gray-900 px-3 py-1 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                        >
                          {edit.saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => cancelEditCompany(c.id)}
                          disabled={edit.saving}
                          className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Header toggle: chevron + name as one button.
                            Sibling chip / Edit / Delete stay outside so
                            we don't violate nested-button HTML. */}
                        <button
                          type="button"
                          onClick={() => toggleCompanyExpanded(c.id)}
                          aria-expanded={contactsOpen}
                          aria-controls={`company-${c.id}-contacts`}
                          className="-ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                        >
                          <svg
                            viewBox="0 0 12 12"
                            aria-hidden="true"
                            className={['h-3 w-3 shrink-0 text-gray-400 transition-transform', contactsOpen ? 'rotate-90' : ''].join(' ')}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="4.5 3 8.5 6 4.5 9" />
                          </svg>
                          <span className="truncate whitespace-nowrap text-sm font-medium text-gray-900">{c.name}</span>
                        </button>
                        <CountBadge
                          count={c.proofCount}
                          expanded={companyProjectsOpen.has(c.id)}
                          onToggle={() => toggleCompanyProjects(c.id)}
                        />
                        <button
                          onClick={() => startEditCompany(c)}
                          className="shrink-0 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                        >
                          Edit
                        </button>
                        <div className="flex-1 border-t border-gray-200" />
                        {canDeleteCompany && (
                          <button
                            onClick={() => setPending({ kind: 'company', id: c.id, name: c.name, contactCount: c.contacts.length })}
                            className="shrink-0 text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
                          >
                            Delete company
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {edit?.rowError && (
                    <p className="mb-2 rounded-md bg-rose-50 px-3 py-1.5 text-xs text-rose-700">{edit.rowError}</p>
                  )}

                  {companyProjectsOpen.has(c.id) && c.proofCount > 0 && (
                    <ProjectList
                      projects={projectsByCompany.get(c.id) ?? []}
                      showContact
                      className="mb-3"
                    />
                  )}

                  {contactsOpen && (
                    <div
                      id={`company-${c.id}-contacts`}
                      className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
                    >
                      {c.contacts.length === 0 ? (
                        <div className="px-5 py-4 text-sm text-gray-400">No contacts.</div>
                      ) : (
                        c.contacts.map((k, i) => (
                          <ContactRowUI
                            key={k.id}
                            contact={k}
                            withTopBorder={i > 0}
                            edit={editingContact[k.id]}
                            companies={companies}
                            projects={projectsByContact.get(k.id) ?? []}
                            expanded={expandedContacts.has(k.id)}
                            onToggleExpanded={() => toggleContactExpanded(k.id)}
                            onStartEdit={() => startEditContact(k)}
                            onCancelEdit={() => cancelEditContact(k.id)}
                            onChangeDraft={(patch) => setContactDraft(k.id, patch)}
                            onSave={() => void saveContact(k)}
                            onDelete={() => setPending({ kind: 'contact', id: k.id, label: k.full_name })}
                          />
                        ))
                      )}
                    </div>
                  )}
                </section>
              )
            })}

            {/* No-company section. Same collapse-by-default behaviour
                as a regular company; a live search auto-opens it so
                orphan matches surface immediately. */}
            {visibleOrphans.length > 0 && (() => {
              const open = searching || orphansExpanded
              return (
                <section>
                  <div className="mb-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setOrphansExpanded((v) => !v)}
                      aria-expanded={open}
                      aria-controls="no-company-contacts"
                      className="-ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                    >
                      <svg
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                        className={['h-3 w-3 shrink-0 text-gray-400 transition-transform', open ? 'rotate-90' : ''].join(' ')}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="4.5 3 8.5 6 4.5 9" />
                      </svg>
                      <span className="whitespace-nowrap text-sm font-medium text-gray-500">No company</span>
                      <span className="ml-1 text-xs text-gray-400">({visibleOrphans.length})</span>
                    </button>
                    <div className="flex-1 border-t border-gray-200" />
                  </div>
                  {open && (
                    <div
                      id="no-company-contacts"
                      className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
                    >
                      {visibleOrphans.map((k, i) => (
                        <ContactRowUI
                          key={k.id}
                          contact={k}
                          withTopBorder={i > 0}
                          edit={editingContact[k.id]}
                          companies={companies}
                          projects={projectsByContact.get(k.id) ?? []}
                          expanded={expandedContacts.has(k.id)}
                          onToggleExpanded={() => toggleContactExpanded(k.id)}
                          onStartEdit={() => startEditContact(k)}
                          onCancelEdit={() => cancelEditContact(k.id)}
                          onChangeDraft={(patch) => setContactDraft(k.id, patch)}
                          onSave={() => void saveContact(k)}
                          onDelete={() => setPending({ kind: 'contact', id: k.id, label: k.full_name })}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })()}

            {!hasResults && (
              <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
                {searching ? (
                  <>
                    <p className="text-gray-400">No companies or contacts match.</p>
                    <button
                      onClick={() => setSearchQuery('')}
                      className="mt-2 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
                    >
                      Clear search
                    </button>
                  </>
                ) : (
                  <p className="text-gray-400">No customers yet.</p>
                )}
              </div>
            )}
          </div>
        )}

      {pending && (
        <ConfirmDialog
          message={
            pending.kind === 'contact'
              ? `Delete ${pending.label}? This cannot be undone.`
              : `Delete ${pending.name} and its ${pending.contactCount} contact${pending.contactCount === 1 ? '' : 's'}? This cannot be undone.`
          }
          working={working}
          errorMsg={errorMsg}
          onConfirm={handleConfirm}
          onCancel={() => { setPending(null); setErrorMsg(null) }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function ContactRowUI({ contact, withTopBorder, edit, companies, projects, expanded, onToggleExpanded, onStartEdit, onCancelEdit, onChangeDraft, onSave, onDelete }: {
  contact: ContactRow
  withTopBorder: boolean
  edit: ContactEdit | undefined
  companies: CompanyRow[]
  projects: ProjectLite[]
  expanded: boolean
  onToggleExpanded: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onChangeDraft: (patch: Partial<ContactEdit>) => void
  onSave: () => void
  onDelete: () => void
}) {
  const canDelete = contact.proofCount === 0
  if (edit) {
    return (
      <div className={['px-5 py-3', withTopBorder ? 'border-t border-gray-100' : ''].join(' ')}>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start">
          <label className="block">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-400">Full name</span>
            <input
              type="text"
              value={edit.draftFullName}
              onChange={(e) => onChangeDraft({ draftFullName: e.target.value })}
              disabled={edit.saving}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-400">Email</span>
            <input
              type="email"
              value={edit.draftEmail}
              onChange={(e) => onChangeDraft({ draftEmail: e.target.value })}
              disabled={edit.saving}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-gray-400">Company</span>
            <select
              value={edit.draftCompanyId ?? ''}
              onChange={(e) => onChangeDraft({ draftCompanyId: e.target.value === '' ? null : e.target.value })}
              disabled={edit.saving}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            >
              <option value="">— No company —</option>
              {[...companies]
                .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </label>
          <div className="flex items-end gap-2 sm:pb-0.5">
            <button
              onClick={onSave}
              disabled={edit.saving}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {edit.saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={edit.saving}
              className="text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
        {edit.rowError && (
          <p className="mt-2 rounded-md bg-rose-50 px-3 py-1.5 text-xs text-rose-700">{edit.rowError}</p>
        )}
      </div>
    )
  }
  return (
    <div className={withTopBorder ? 'border-t border-gray-100' : ''}>
      <div className="flex items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-gray-900">{contact.full_name}</div>
          <div className="truncate text-xs text-gray-400">{contact.email}</div>
        </div>
        <CountBadge
          count={contact.proofCount}
          expanded={expanded}
          onToggle={onToggleExpanded}
        />
        <button
          onClick={onStartEdit}
          className="shrink-0 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
        >
          Edit
        </button>
        {canDelete && (
          <button
            onClick={onDelete}
            className="shrink-0 text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
          >
            Delete
          </button>
        )}
      </div>
      {expanded && contact.proofCount > 0 && (
        <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-3">
          <ProjectList projects={projects} />
        </div>
      )}
    </div>
  )
}

function CountBadge({ count, expanded, onToggle }: {
  count: number
  expanded?: boolean
  onToggle?: () => void
}) {
  if (count === 0) {
    // No projects — a quiet em-dash chip. Inert; nothing to expand.
    return (
      <span
        title="No projects"
        aria-label="No projects"
        className="shrink-0 inline-flex items-center rounded-md bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-400"
      >
        —
      </span>
    )
  }
  const projectsWord = count === 1 ? 'project' : 'projects'
  const title = expanded ? `Hide ${count} ${projectsWord}` : `Show ${count} ${projectsWord}`
  if (!onToggle) {
    // Non-interactive variant (no toggle handler) — same look minus the
    // chevron, still tooltip-labelled for screen readers.
    return (
      <span
        title={`${count} ${projectsWord}`}
        className="shrink-0 inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-700"
      >
        {count}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={title}
      title={title}
      className="shrink-0 inline-flex items-center gap-0.5 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-1"
    >
      <span>{count}</span>
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className={['h-2.5 w-2.5 text-gray-500 transition-transform', expanded ? 'rotate-180' : ''].join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="3 4.5 6 7.5 9 4.5" />
      </svg>
    </button>
  )
}

// ── Project list (inline expansion under a count badge) ──────────────────────
//
// One row per proof. Rows link to the proof detail page. The same
// component is used under both a company badge (showContact = true: rows
// are scoped to one company but span several contacts) and a contact
// badge (showContact omitted: rows are already one-contact-scoped, so
// the contact name would be redundant).

function ProjectList({ projects, showContact, className }: {
  projects: ProjectLite[]
  showContact?: boolean
  className?: string
}) {
  if (projects.length === 0) {
    // Defensive — the parent only mounts us when count > 0, but a stale
    // count (rare) is better caught with a quiet line than an empty box.
    return (
      <div className={['rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-400', className ?? ''].join(' ')}>
        No matching projects to show.
      </div>
    )
  }
  // Newest activity first; projects without a last_activity_at fall to
  // the end. The load() query already orders this way, but sort here
  // too so a stale render order can't leak through.
  const ordered = [...projects].sort((a, b) => {
    const av = a.last_activity_at ?? ''
    const bv = b.last_activity_at ?? ''
    if (av === bv) return 0
    if (!av) return 1
    if (!bv) return -1
    return bv.localeCompare(av)
  })
  return (
    <div className={['overflow-hidden rounded-xl bg-white ring-1 ring-gray-200', className ?? ''].join(' ')}>
      {ordered.map((p, i) => (
        <Link
          key={p.proof_id}
          to={`/proofs/${p.proof_id}`}
          className={[
            'flex items-center gap-3 px-4 py-2 text-xs hover:bg-gray-50',
            i > 0 ? 'border-t border-gray-100' : '',
          ].join(' ')}
        >
          <StatusDot status={p.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-gray-900">
              {projectTitle(p, !!showContact)}
              {p.current_version_number != null && (
                <span className="ml-2 text-xs text-gray-400">v{p.current_version_number}</span>
              )}
            </div>
            {p.material_display && (
              <div className="truncate text-xs text-gray-400">{p.material_display}</div>
            )}
          </div>
          <span className="shrink-0 text-xs text-gray-400">{statusLabel(p.status)}</span>
          <span className="shrink-0 text-xs text-gray-400">
            {p.last_activity_at ? relativeTime(p.last_activity_at) : ''}
          </span>
        </Link>
      ))}
    </div>
  )
}

// Row label. Inside a company expansion we lead with the contact name —
// that's the disambiguator when one company has projects across several
// contacts. Inside a contact expansion contact is fixed, so we lead with
// the company name (matches the dashboard's projectName heuristic).
function projectTitle(p: ProjectLite, showContact: boolean): string {
  if (showContact) return p.contact_name || '(no contact)'
  return p.company_name || p.contact_name || '(no contact)'
}

function statusLabel(status: ProofStatus): string {
  if (status === 'approved')  return 'Approved'
  if (status === 'dormant')   return 'Dormant'
  if (status === 'abandoned') return 'Abandoned'
  return 'In progress'
}

function StatusDot({ status }: { status: ProofStatus }) {
  const colour =
    status === 'approved'  ? 'bg-emerald-500'
    : status === 'dormant'  ? 'bg-gray-300'
    : status === 'abandoned' ? 'bg-slate-400'
    :                          'bg-amber-400'
  return (
    <span
      aria-hidden="true"
      className={['h-2 w-2 shrink-0 rounded-full', colour].join(' ')}
    />
  )
}

// Compact native-select dropdown with a chevron. Mirrors the SelectField
// helper in DashboardPage so the visual language is consistent across
// admin tools. Native <select> gets keyboard accessibility, the OS picker
// on mobile, and screen-reader semantics for free.
function SelectField<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="relative inline-flex items-center rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-50 focus-within:ring-2 focus-within:ring-gray-900">
      {label && (
        <span className="pointer-events-none select-none pl-2.5 text-xs font-medium text-gray-400">
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-xs font-medium text-gray-800 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 6 8 10 12 6" />
      </svg>
    </div>
  )
}

function ConfirmDialog({
  message,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: {
  message: string
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel="Confirm delete"
      panelClassName="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
    >
      <p className="text-sm text-gray-700">{message}</p>
      {errorMsg && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={working}
          className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={working}
          className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
        >
          {working ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  )
}
