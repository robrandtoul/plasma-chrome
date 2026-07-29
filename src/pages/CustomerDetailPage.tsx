import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import ContactNameNudge from '../components/ContactNameNudge'
import {
  ConfirmDialog,
  ProjectList,
  isValidEmail,
  type ProjectLite,
} from './customers/parts'

// Per-company customer detail (PR 55). Reached from the lean Customers
// list. Shows one company's contacts, each with their projects, and is
// the home for all editing — company rename/delete, contact
// add/edit/delete — that used to be crammed inline into the list.
//
// The special :companyId === 'none' renders the "No company" bucket:
// every contact with company_id IS NULL. Company-level affordances
// (rename, delete) are hidden in that mode since there's no company row.

interface ContactRow {
  id: string
  full_name: string
  email: string
  company_id: string | null
  proofCount: number
}

interface CompanyOption {
  id: string
  name: string
}

interface ContactEdit {
  draftFullName: string
  draftEmail: string
  draftCompanyId: string | null
  saving: boolean
  rowError: string | null
}

type Pending =
  | { kind: 'contact'; id: string; label: string }
  | { kind: 'company'; id: string; name: string; contactCount: number }

export default function CustomerDetailPage() {
  const { companyId = '' } = useParams<{ companyId: string }>()
  const isOrphans = companyId === 'none'
  const navigate = useNavigate()

  const [companyName, setCompanyName] = useState<string | null>(null)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [projectsByContact, setProjectsByContact] = useState<Map<string, ProjectLite[]>>(new Map())
  const [allCompanies, setAllCompanies] = useState<CompanyOption[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Company rename
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)

  // Contact edit / add
  const [editingContact, setEditingContact] = useState<Record<string, ContactEdit>>({})
  const [adding, setAdding] = useState<ContactEdit | null>(null)

  // Delete confirm
  const [pending, setPending] = useState<Pending | null>(null)
  const [working, setWorking] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => { void load() }, [companyId])

  async function load() {
    setLoading(true)
    setNotFound(false)

    // Per-contact project count is derived from the projects feed (the
    // same rows we list under each contact), so the count and the listed
    // projects always agree — no separate nested proof_versions(count).
    const contactSelect = 'id, full_name, email, company_id'
    const projectSelect = 'proof_id, status, contact_id, contact_name, company_id, company_name, current_version_number, material_display, last_activity_at'

    if (isOrphans) {
      const [contactsResult, companiesResult, projectsResult] = await Promise.all([
        supabase.from('contacts').select(contactSelect).is('company_id', null).order('full_name'),
        supabase.from('companies').select('id, name').order('name'),
        supabase.from('public_dashboard_projects').select(projectSelect)
          .is('company_id', null)
          .order('last_activity_at', { ascending: false, nullsFirst: false })
          .limit(2000),
      ])
      setCompanyName(null)
      setAllCompanies((companiesResult.data ?? []) as CompanyOption[])
      ingest(contactsResult.data ?? [], (projectsResult.data ?? []) as ProjectLite[])
      setLoading(false)
      return
    }

    const [companyResult, companiesResult, projectsResult] = await Promise.all([
      supabase.from('companies').select(`id, name, contacts(${contactSelect})`).eq('id', companyId).maybeSingle(),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('public_dashboard_projects').select(projectSelect)
        .eq('company_id', companyId)
        .order('last_activity_at', { ascending: false, nullsFirst: false })
        .limit(2000),
    ])

    if (!companyResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }
    setCompanyName((companyResult.data as any).name)
    setAllCompanies((companiesResult.data ?? []) as CompanyOption[])
    ingest((companyResult.data as any).contacts ?? [], (projectsResult.data ?? []) as ProjectLite[])
    setLoading(false)
  }

  // Build the per-contact project map first, then derive each contact's
  // count from it, so count and listed projects are one source.
  function ingest(rawContacts: any[], rawProjects: ProjectLite[]) {
    const map = new Map<string, ProjectLite[]>()
    for (const p of rawProjects) {
      if (!p.contact_id) continue
      const arr = map.get(p.contact_id) ?? []
      arr.push(p)
      map.set(p.contact_id, arr)
    }
    setProjectsByContact(map)
    const rows: ContactRow[] = rawContacts.map((k) => ({
      id: k.id,
      full_name: k.full_name,
      email: k.email,
      company_id: k.company_id,
      proofCount: map.get(k.id)?.length ?? 0,
    }))
    rows.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' }))
    setContacts(rows)
  }

  const proofCount = useMemo(() => contacts.reduce((s, k) => s + k.proofCount, 0), [contacts])

  function showToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }

  // ── Company rename ──────────────────────────────────────────
  function startRename() {
    setNameDraft(companyName ?? '')
    setRenameError(null)
    setRenaming(true)
  }

  async function saveRename() {
    const trimmed = nameDraft.trim()
    if (!trimmed) { setRenameError('Name is required.'); return }
    if (trimmed === companyName) { setRenaming(false); return }
    setRenameSaving(true)
    setRenameError(null)
    const { data, error } = await supabase
      .from('companies').update({ name: trimmed }).eq('id', companyId).select('id, name').single()
    setRenameSaving(false)
    if (error || !data) {
      setRenameError((error as any)?.code === '23505' ? `A company called "${trimmed}" already exists.` : error?.message ?? 'Save failed.')
      return
    }
    void logAudit({ action: 'company.updated', targetType: 'company', targetId: companyId, targetLabel: data.name, beforeValue: { name: companyName }, afterValue: { name: data.name } })
    setCompanyName(data.name)
    setRenaming(false)
  }

  // ── Contact edit ────────────────────────────────────────────
  function startEditContact(k: ContactRow) {
    setEditingContact((prev) => ({ ...prev, [k.id]: { draftFullName: k.full_name, draftEmail: k.email, draftCompanyId: k.company_id, saving: false, rowError: null } }))
  }
  function cancelEditContact(id: string) {
    setEditingContact((prev) => { const { [id]: _, ...rest } = prev; return rest })
  }
  function setContactDraft(id: string, patch: Partial<ContactEdit>) {
    setEditingContact((prev) => ({ ...prev, [id]: { ...prev[id], ...patch, rowError: null } }))
  }

  async function saveContact(k: ContactRow) {
    const draft = editingContact[k.id]
    if (!draft) return
    const name = draft.draftFullName.trim()
    const email = draft.draftEmail.trim()
    if (!name) { setContactDraft(k.id, { rowError: 'Name is required.' }); return }
    if (!email) { setContactDraft(k.id, { rowError: 'Email is required.' }); return }
    if (!isValidEmail(email)) { setContactDraft(k.id, { rowError: 'Email looks malformed.' }); return }
    const after = { full_name: name, email, company_id: draft.draftCompanyId }
    const before = { full_name: k.full_name, email: k.email, company_id: k.company_id }
    if (before.full_name === after.full_name && before.email === after.email && before.company_id === after.company_id) {
      cancelEditContact(k.id); return
    }
    setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, saving: true, rowError: null } }))
    const { data, error } = await supabase.from('contacts').update(after).eq('id', k.id).select('id').single()
    if (error || !data) {
      const friendly = (error as any)?.code === '23505' ? 'Another contact in that company already uses this email.' : error?.message ?? 'Save failed.'
      setEditingContact((prev) => ({ ...prev, [k.id]: { ...draft, saving: false, rowError: friendly } }))
      return
    }
    void logAudit({ action: 'contact.updated', targetType: 'contact', targetId: k.id, targetLabel: name, beforeValue: before, afterValue: after })
    cancelEditContact(k.id)
    // Contact may have moved to another company — reload to re-scope.
    await load()
  }

  // ── Add contact ─────────────────────────────────────────────
  function startAdd() {
    setAdding({ draftFullName: '', draftEmail: '', draftCompanyId: isOrphans ? null : companyId, saving: false, rowError: null })
  }
  async function saveAdd() {
    if (!adding) return
    const name = adding.draftFullName.trim()
    const email = adding.draftEmail.trim()
    if (!name) { setAdding({ ...adding, rowError: 'Name is required.' }); return }
    if (!email) { setAdding({ ...adding, rowError: 'Email is required.' }); return }
    if (!isValidEmail(email)) { setAdding({ ...adding, rowError: 'Email looks malformed.' }); return }
    setAdding({ ...adding, saving: true, rowError: null })
    const { data, error } = await supabase
      .from('contacts')
      .insert({ full_name: name, email, company_id: adding.draftCompanyId })
      .select('id').single()
    if (error || !data) {
      const friendly = (error as any)?.code === '23505' ? 'A contact in that company already uses this email.' : error?.message ?? 'Add failed.'
      setAdding({ ...adding, saving: false, rowError: friendly })
      return
    }
    void logAudit({ action: 'contact.created', targetType: 'contact', targetId: data.id, targetLabel: name })
    setAdding(null)
    showToast(`Added ${name}`)
    await load()
  }

  // ── Delete ──────────────────────────────────────────────────
  async function handleConfirm() {
    if (!pending) return
    setWorking(true)
    setErrorMsg(null)
    try {
      if (pending.kind === 'contact') {
        const { error } = await supabase.rpc('delete_contact_if_empty', { p_contact_id: pending.id })
        if (error) throw new Error(error.message)
        void logAudit({ action: 'contact.deleted', targetType: 'contact', targetId: pending.id, targetLabel: pending.label })
        showToast(`Deleted ${pending.label}`)
        setPending(null)
        await load()
      } else {
        const { error } = await supabase.rpc('delete_company_if_empty', { p_company_id: pending.id })
        if (error) throw new Error(error.message)
        void logAudit({ action: 'company.deleted', targetType: 'company', targetId: pending.id, targetLabel: pending.name, metadata: { cascaded_contacts: pending.contactCount } })
        // Company gone — return to the list.
        navigate('/admin/customers')
      }
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  const heading = isOrphans ? 'No company' : (companyName ?? '')

  return (
    <div>
      <Link
        to="/admin/customers"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-mute hover:text-ink"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="7.5 3 3.5 6 7.5 9" />
        </svg>
        All customers
      </Link>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line" />
        </div>
      ) : notFound ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm border border-line">
          <p className="text-ink-mute">That company no longer exists.</p>
        </div>
      ) : (
        <>
          {/* Company header */}
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {renaming ? (
                <div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => { setNameDraft(e.target.value); setRenameError(null) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenaming(false) }}
                      autoFocus
                      disabled={renameSaving}
                      className="min-w-0 rounded border border-line bg-white px-2.5 py-1 text-lg font-bold text-ink shadow-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                      aria-label="Company name"
                    />
                    <button onClick={() => void saveRename()} disabled={renameSaving} className="rounded bg-ink px-3 py-1.5 text-xs font-semibold text-on-ink hover:opacity-90 disabled:opacity-50">
                      {renameSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setRenaming(false)} disabled={renameSaving} className="text-xs font-medium text-ink-mute hover:text-ink disabled:opacity-50">Cancel</button>
                  </div>
                  {renameError && <p className="mt-2 rounded-md bg-out-soft px-3 py-1.5 text-xs text-out">{renameError}</p>}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <h2 className={['text-xl font-bold', isOrphans ? 'text-ink-mute italic' : 'text-ink'].join(' ')}>{heading}</h2>
                  {!isOrphans && (
                    <button onClick={startRename} className="text-xs font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline">
                      Rename
                    </button>
                  )}
                </div>
              )}
              <p className="mt-1 text-sm text-ink-mute">
                {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'} · {proofCount} {proofCount === 1 ? 'project' : 'projects'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={startAdd}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-on-ink hover:opacity-90"
              >
                Add contact
              </button>
              {!isOrphans && proofCount === 0 && (
                <button
                  onClick={() => setPending({ kind: 'company', id: companyId, name: companyName ?? '', contactCount: contacts.length })}
                  className="rounded px-3 py-2 text-sm font-medium text-out hover:bg-out-soft"
                >
                  Delete company
                </button>
              )}
            </div>
          </div>

          {/* Add-contact inline form */}
          {adding && (
            <div className="mb-4 rounded-2xl bg-white p-4 shadow-sm border border-line">
              <ContactEditFields
                edit={adding}
                companies={allCompanies}
                onChange={(patch) => setAdding({ ...adding, ...patch, rowError: null })}
                onSave={() => void saveAdd()}
                onCancel={() => setAdding(null)}
                saveLabel="Add"
              />
            </div>
          )}

          {/* Contacts */}
          {contacts.length === 0 ? (
            <div className="rounded-2xl bg-white py-12 text-center shadow-sm border border-line">
              <p className="text-ink-mute">No contacts yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {contacts.map((k) => {
                const edit = editingContact[k.id]
                const projects = projectsByContact.get(k.id) ?? []
                return (
                  <div key={k.id} className="overflow-hidden rounded-2xl bg-white shadow-sm border border-line">
                    {edit ? (
                      <div className="p-4">
                        <ContactEditFields
                          edit={edit}
                          companies={allCompanies}
                          onChange={(patch) => setContactDraft(k.id, patch)}
                          onSave={() => void saveContact(k)}
                          onCancel={() => cancelEditContact(k.id)}
                          saveLabel="Save"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 px-5 py-3.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-ink">{k.full_name}</div>
                          <div className="truncate text-xs text-ink-mute">{k.email}</div>
                        </div>
                        <button onClick={() => startEditContact(k)} className="shrink-0 text-xs font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline">Edit</button>
                        {k.proofCount === 0 && (
                          <button onClick={() => setPending({ kind: 'contact', id: k.id, label: k.full_name })} className="shrink-0 text-xs font-medium text-out underline-offset-2 hover:underline">Delete</button>
                        )}
                      </div>
                    )}
                    <div className="border-t border-line-soft bg-canvas px-5 py-3">
                      {k.proofCount > 0 ? (
                        <ProjectList projects={projects} />
                      ) : (
                        <p className="text-xs text-ink-mute">No projects.</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
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
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-on-ink shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function ContactEditFields({ edit, companies, onChange, onSave, onCancel, saveLabel }: {
  edit: ContactEdit
  companies: CompanyOption[]
  onChange: (patch: Partial<ContactEdit>) => void
  onSave: () => void
  onCancel: () => void
  saveLabel: string
}) {
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <label className="block">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-mute">Full name</span>
          <input type="text" value={edit.draftFullName} onChange={(e) => onChange({ draftFullName: e.target.value })} disabled={edit.saving} autoFocus
            className="mt-1 w-full rounded border border-line bg-white px-2.5 py-1.5 text-sm text-ink shadow-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-mute">Email</span>
          <input type="email" value={edit.draftEmail} onChange={(e) => onChange({ draftEmail: e.target.value })} disabled={edit.saving}
            className="mt-1 w-full rounded border border-line bg-white px-2.5 py-1.5 text-sm text-ink shadow-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-mute">Company</span>
          <select value={edit.draftCompanyId ?? ''} onChange={(e) => onChange({ draftCompanyId: e.target.value === '' ? null : e.target.value })} disabled={edit.saving}
            className="select-styled mt-1 w-full rounded border border-line bg-white px-2 py-1.5 text-sm text-ink shadow-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none">
            <option value="">— No company —</option>
            {[...companies].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 sm:pb-0.5">
          <button onClick={onSave} disabled={edit.saving} className="rounded bg-ink px-3 py-1.5 text-xs font-semibold text-on-ink hover:opacity-90 disabled:opacity-50">
            {edit.saving ? 'Saving…' : saveLabel}
          </button>
          <button onClick={onCancel} disabled={edit.saving} className="text-xs font-medium text-ink-mute hover:text-ink disabled:opacity-50">Cancel</button>
        </div>
      </div>
      {/* Where the backlog of first-name-only contacts actually gets cleared:
          this editor is shared by the add and edit paths, so both are covered. */}
      <ContactNameNudge
        fullName={edit.draftFullName}
        email={edit.draftEmail}
        onApply={(name) => onChange({ draftFullName: name })}
        warnWithoutSuggestion
        // Every other control in this row is gated on edit.saving; without
        // this the button stays live mid-save and the correction it applies
        // is dropped by the in-flight write.
        busy={edit.saving}
      />
      {edit.rowError && <p className="mt-2 rounded-md bg-out-soft px-3 py-1.5 text-xs text-out">{edit.rowError}</p>}
    </div>
  )
}
