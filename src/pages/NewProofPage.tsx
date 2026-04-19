import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

// ── Local types ───────────────────────────────────────────────────────────────

interface Company {
  id: string
  name: string
}

interface Contact {
  id: string
  full_name: string
  email: string
}

// null id = not yet persisted (will be created on submit)
type SelectedCompany = { id: string; name: string } | { id: null; name: string }

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProofPage() {
  const { session } = useAuth()
  const navigate = useNavigate()

  // ── Company state ──────────────────────────────────────────────────────────
  const [allCompanies, setAllCompanies] = useState<Company[]>([])
  const [companySearch, setCompanySearch] = useState('')
  const [selectedCompany, setSelectedCompany] = useState<SelectedCompany | null>(null)
  const [isIndividual, setIsIndividual] = useState(false)
  const [companyOpen, setCompanyOpen] = useState(false)
  const companyRef = useRef<HTMLDivElement>(null)

  // ── Contact state ──────────────────────────────────────────────────────────
  const [allContacts, setAllContacts] = useState<Contact[]>([])
  const [contactSearch, setContactSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [contactOpen, setContactOpen] = useState(false)
  const [addingContact, setAddingContact] = useState(false)
  const [newContactName, setNewContactName] = useState('')
  const [newContactEmail, setNewContactEmail] = useState('')
  const contactRef = useRef<HTMLDivElement>(null)

  // ── Proof fields ───────────────────────────────────────────────────────────
  const [helpscoutUrl, setHelpscoutUrl] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Load all companies once on mount
  useEffect(() => {
    supabase.from('companies').select('id, name').order('name')
      .then(({ data }) => setAllCompanies((data ?? []) as Company[]))
  }, [])

  // Load contacts whenever the selected company (or individual mode) changes.
  // Auto-enters add-new mode when the contact list is empty (new company,
  // or an existing company that has no contacts yet).
  useEffect(() => {
    setAllContacts([])
    setSelectedContact(null)
    setContactSearch('')
    setAddingContact(false)
    setNewContactName('')
    setNewContactEmail('')

    if (!isIndividual && !selectedCompany) return

    async function load() {
      let contacts: Contact[] = []

      if (isIndividual) {
        const { data } = await supabase
          .from('contacts').select('id, full_name, email')
          .is('company_id', null).order('full_name')
        contacts = (data ?? []) as Contact[]
      } else if (selectedCompany!.id) {
        // existing company — UUID present
        const { data } = await supabase
          .from('contacts').select('id, full_name, email')
          .eq('company_id', selectedCompany!.id).order('full_name')
        contacts = (data ?? []) as Contact[]
      }
      // new company (id = null) → contacts stays [], falls through to add mode

      setAllContacts(contacts)
      if (contacts.length === 0) {
        // Nothing to choose from — drop straight into the add-new form
        setAddingContact(true)
      }
    }

    load()
  }, [selectedCompany?.id, isIndividual])

  // Close dropdowns when clicking outside their containers
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (companyRef.current && !companyRef.current.contains(e.target as Node)) {
        setCompanyOpen(false)
      }
      if (contactRef.current && !contactRef.current.contains(e.target as Node)) {
        setContactOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────

  const companyResolved = isIndividual || selectedCompany !== null

  const filteredCompanies = companySearch.trim()
    ? allCompanies.filter((c) => c.name.toLowerCase().includes(companySearch.toLowerCase()))
    : allCompanies

  const exactCompanyMatch = allCompanies.some(
    (c) => c.name.toLowerCase() === companySearch.trim().toLowerCase()
  )

  const filteredContacts = contactSearch.trim()
    ? allContacts.filter(
        (c) =>
          c.full_name.toLowerCase().includes(contactSearch.toLowerCase()) ||
          c.email.toLowerCase().includes(contactSearch.toLowerCase())
      )
    : allContacts

  // ── Company handlers ───────────────────────────────────────────────────────

  function selectCompany(c: Company) {
    setSelectedCompany({ id: c.id, name: c.name })
    setCompanySearch(c.name)
    setCompanyOpen(false)
  }

  function addNewCompany() {
    const name = companySearch.trim()
    if (!name) return
    setSelectedCompany({ id: null, name })
    setCompanyOpen(false)
  }

  function clearCompany() {
    setSelectedCompany(null)
    setCompanySearch('')
    setIsIndividual(false)
  }

  function handleIndividualToggle(checked: boolean) {
    setIsIndividual(checked)
    if (checked) {
      setSelectedCompany(null)
      setCompanySearch('')
      setCompanyOpen(false)
    }
  }

  // ── Contact handlers ───────────────────────────────────────────────────────

  function selectContact(c: Contact) {
    setSelectedContact(c)
    setContactSearch(c.full_name)
    setContactOpen(false)
    setAddingContact(false)
  }

  function chooseAddContact() {
    // Pre-populate the name field with whatever the user typed in the search box
    if (contactSearch.trim()) setNewContactName(contactSearch.trim())
    setAddingContact(true)
    setSelectedContact(null)
    setContactOpen(false)
    setContactSearch('')
  }

  function clearContact() {
    setSelectedContact(null)
    setAddingContact(false)
    setContactSearch('')
    setNewContactName('')
    setNewContactEmail('')
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!isIndividual && !selectedCompany) {
      setError('Please select or add a company, or tick "No company".')
      return
    }
    if (!selectedContact && !addingContact) {
      setError('Please select or add a contact.')
      return
    }
    if (addingContact) {
      if (!newContactName.trim()) { setError('Contact full name is required.'); return }
      if (!newContactEmail.trim()) { setError('Contact email is required.'); return }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContactEmail.trim())) {
        setError('Please enter a valid email address.')
        return
      }
    }

    setSubmitting(true)
    try {
      // 1. Create company if it's new
      let companyId: string | null = null
      if (!isIndividual) {
        if (selectedCompany!.id === null) {
          const { data, error } = await supabase
            .from('companies')
            .insert({ name: selectedCompany!.name.trim() })
            .select('id')
            .single()
          if (error) {
            if (error.code === '23505') {
              throw new Error(`A company called "${selectedCompany!.name}" already exists.`)
            }
            throw new Error(`Failed to create company: ${error.message}`)
          }
          companyId = data.id
        } else {
          companyId = selectedCompany!.id
        }
      }

      // 2. Create contact if it's new
      let contactId: string
      if (selectedContact) {
        contactId = selectedContact.id
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            company_id: companyId,
            full_name: newContactName.trim(),
            email: newContactEmail.trim().toLowerCase(),
          })
          .select('id')
          .single()
        if (error) {
          if (error.code === '23505') {
            throw new Error('A contact with this email already exists in this company.')
          }
          throw new Error(`Failed to create contact: ${error.message}`)
        }
        contactId = data.id
      }

      // 3. Create proof
      const { data, error } = await supabase
        .from('proofs')
        .insert({
          contact_id: contactId,
          helpscout_thread_url: helpscoutUrl.trim() || null,
          internal_notes: internalNotes.trim() || null,
          created_by: session!.user.id,
        })
        .select('id')
        .single()

      if (error) throw new Error(`Failed to create proof: ${error.message}`)
      navigate(`/proofs/${data.id}`)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to proofs</Link>
        </div>

        <h1 className="mb-8 text-2xl font-bold text-gray-900">New proof</h1>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* ── Company ──────────────────────────────────────────────────── */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Company</h2>

            {!isIndividual && !selectedCompany && (
              <div ref={companyRef} className="relative mb-3">
                <input
                  type="text"
                  placeholder="Search or add company…"
                  value={companySearch}
                  onChange={(e) => { setCompanySearch(e.target.value); setCompanyOpen(true) }}
                  onFocus={() => setCompanyOpen(true)}
                  className={inputClass}
                  autoComplete="off"
                />
                {companyOpen && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                    {filteredCompanies.length === 0 && !companySearch.trim() && (
                      <p className="px-3 py-3 text-sm text-gray-400">No companies yet — type to add one.</p>
                    )}
                    {filteredCompanies.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => selectCompany(c)}
                        className="flex w-full px-3 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-50"
                      >
                        {c.name}
                      </button>
                    ))}
                    {companySearch.trim() && !exactCompanyMatch && (
                      <button
                        type="button"
                        onClick={addNewCompany}
                        className={[
                          'flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm text-gray-500 hover:bg-gray-50',
                          filteredCompanies.length > 0 ? 'border-t border-gray-100' : '',
                        ].join(' ')}
                      >
                        <span className="text-gray-400">+</span>
                        Add new company:{' '}
                        <span className="font-medium text-gray-900">"{companySearch.trim()}"</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isIndividual && selectedCompany && (
              <div className="mb-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{selectedCompany.name}</span>
                  {selectedCompany.id === null && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                      New
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={clearCompany}
                  className="ml-3 shrink-0 text-xs text-gray-400 underline hover:text-gray-700"
                >
                  Change
                </button>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isIndividual}
                onChange={(e) => handleIndividualToggle(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-sm text-gray-600">No company (individual)</span>
            </label>
          </section>

          {/* ── Contact (shown once company is resolved) ─────────────────── */}
          {companyResolved && (
            <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Contact</h2>

              {/* Combobox input — only when no contact resolved */}
              {!selectedContact && !addingContact && (
                <div ref={contactRef} className="relative">
                  <input
                    type="text"
                    placeholder="Search by name or email…"
                    value={contactSearch}
                    onChange={(e) => { setContactSearch(e.target.value); setContactOpen(true) }}
                    onFocus={() => setContactOpen(true)}
                    className={inputClass}
                    autoComplete="off"
                  />
                  {contactOpen && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                      {filteredContacts.length === 0 && !contactSearch.trim() && (
                        <p className="px-3 py-3 text-sm text-gray-400">
                          No contacts{selectedCompany?.id === null ? ' yet (new company)' : ' for this company'}.
                        </p>
                      )}
                      {filteredContacts.length === 0 && contactSearch.trim() && (
                        <p className="px-3 py-3 text-sm text-gray-400">No matches.</p>
                      )}
                      {filteredContacts.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectContact(c)}
                          className="flex w-full flex-col px-3 py-2.5 text-left hover:bg-gray-50"
                        >
                          <span className="text-sm font-medium text-gray-900">{c.full_name}</span>
                          <span className="text-xs text-gray-500">{c.email}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={chooseAddContact}
                        className={[
                          'flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm text-gray-500 hover:bg-gray-50',
                          filteredContacts.length > 0 ? 'border-t border-gray-100' : '',
                        ].join(' ')}
                      >
                        <span className="text-gray-400">+</span>
                        {contactSearch.trim() ? (
                          <>
                            Add new contact:{' '}
                            <span className="font-medium text-gray-900">"{contactSearch.trim()}"</span>
                          </>
                        ) : (
                          'Add new contact'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Selected contact pill */}
              {selectedContact && (
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{selectedContact.full_name}</span>
                    <span className="ml-2 text-sm text-gray-500">{selectedContact.email}</span>
                  </div>
                  <button
                    type="button"
                    onClick={clearContact}
                    className="ml-3 shrink-0 text-xs text-gray-400 underline hover:text-gray-700"
                  >
                    Change
                  </button>
                </div>
              )}

              {/* New contact inline form */}
              {addingContact && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">New contact</span>
                    {/* Only show Cancel when there are existing contacts to revert to */}
                    {allContacts.length > 0 && (
                      <button
                        type="button"
                        onClick={clearContact}
                        className="text-xs text-gray-400 underline hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">
                      Full name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={newContactName}
                      onChange={(e) => setNewContactName(e.target.value)}
                      placeholder="e.g. Alice Thompson"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-gray-700">
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={newContactEmail}
                      onChange={(e) => setNewContactEmail(e.target.value)}
                      placeholder="e.g. alice@acmecorp.com"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ── Internal fields ───────────────────────────────────────────── */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Internal</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Help Scout thread URL{' '}
                <span className="font-normal text-gray-400">(recommended)</span>
              </label>
              <input
                type="url"
                value={helpscoutUrl}
                onChange={(e) => setHelpscoutUrl(e.target.value)}
                placeholder="https://secure.helpscout.net/…"
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Internal notes{' '}
                <span className="font-normal text-gray-400">(optional, never shown to customers)</span>
              </label>
              <textarea
                rows={3}
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                className={inputClass}
              />
            </div>
          </section>

          {error && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create proof'}
          </button>
        </form>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
