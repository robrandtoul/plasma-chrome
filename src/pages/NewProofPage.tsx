import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { parseHelpscoutUrl, MIN_OVERRIDE_REASON_LENGTH } from '../lib/helpscout'
import { titleCase } from '../lib/titleCase'
import { QuoteLink } from '../components/QuoteLink'
import Modal from '../components/Modal'

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

interface HelpScoutMatch {
  id: number
  subject: string | null
  status: string | null
  modifiedAt: string | null
  url: string
  mailboxId: number | null
  mailboxName: string | null
}

// null id = not yet persisted (will be created on submit)
type SelectedCompany = { id: string; name: string } | { id: null; name: string }

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProofPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const prefillCompanyId = searchParams.get('companyId')
  const prefillContactId = searchParams.get('contactId')

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
  const contactInputRef = useRef<HTMLInputElement>(null)
  const helpscoutSectionRef = useRef<HTMLDivElement>(null)

  // Prefill tokens — consumed once so later user edits don't re-apply them.
  // NOTE: pendingContactPrefillRef is consumed on the first effect pass
  // that runs load() past its early-return. If URL-prefill ever starts
  // interacting with an identity flip (e.g. a future "flip individual
  // mode post-prefill" flow), the ref would be consumed on the first
  // pass and unable to restore on subsequent passes — same shape as the
  // pendingPasteNewContactRef bug this file once had. See the "sticky
  // ref" pattern used below for that ref if you need to harden this one.
  const pendingContactPrefillRef = useRef<string | null>(prefillContactId)
  const pendingFocusContactRef   = useRef<boolean>(!!prefillCompanyId && !prefillContactId)
  // Populated by the paste-from-Help-Scout flow when the customer
  // isn't already in our DB. Sticky across identity flips — the
  // contact-load effect re-applies it on every pass until one of
  // selectContact / clearContact explicitly clears it (or the
  // component unmounts on submit). Needed so that unticking
  // "No company (individual)" after a paste of a customer whose HS
  // record had no organization doesn't wipe the prefilled name +
  // email when the effect re-runs.
  const pendingPasteNewContactRef = useRef<{ name: string; email: string } | null>(null)

  // ── Proof fields ───────────────────────────────────────────────────────────
  const [helpscoutUrl, setHelpscoutUrl] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ── Help Scout auto-link ───────────────────────────────────────────────────
  const [hsConversationId, setHsConversationId] = useState<string | null>(null)
  const [hsLinkedSubject, setHsLinkedSubject] = useState<string | null>(null)
  const [hsLookupEmail, setHsLookupEmail] = useState<string | null>(null)
  const [hsPickerOpen, setHsPickerOpen] = useState(false)
  const [hsPickerMatches, setHsPickerMatches] = useState<HelpScoutMatch[]>([])
  const [hsLookupError, setHsLookupError] = useState<string | null>(null)
  const [hsLookupInFlight, setHsLookupInFlight] = useState(false)
  // Shown when a lookup came back with zero matches, or the designer
  // clicked the "these aren't right" escape hatch on the multi-match
  // picker. Populated reason becomes helpscout_override_reason on the
  // proof row when a link isn't available.
  const [hsLookupReturnedZero, setHsLookupReturnedZero] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [urlFormatError, setUrlFormatError] = useState<string | null>(null)

  // ── Paste-from-Help-Scout flow (primary entry point) ───────────────────────
  const [pasteInput, setPasteInput] = useState('')
  const [pasteInFlight, setPasteInFlight] = useState(false)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pasteSubject, setPasteSubject] = useState<string | null>(null)
  // Manual-details disclosure. Collapsed by default; opens
  // automatically on paste success so the designer reviews what
  // got auto-filled.
  const [manualOpen, setManualOpen] = useState(false)
  // Help Scout customer.createdAt (ISO) from the most recent paste
  // lookup. Drives the "Customer since YYYY" subtitle under the
  // staged company. Cleared whenever the company / contact is
  // reset so the subtitle can't outlive the paste result.
  const [customerCreatedAt, setCustomerCreatedAt] = useState<string | null>(null)

  // Load all companies once on mount
  useEffect(() => {
    supabase.from('companies').select('id, name').order('name')
      .then(({ data }) => setAllCompanies((data ?? []) as Company[]))
  }, [])

  // Apply URL prefill once on mount. Contact selection is deferred to the
  // contact-load effect below so it survives that effect's reset pass.
  useEffect(() => {
    async function applyPrefill() {
      if (prefillContactId) {
        const { data } = await supabase
          .from('contacts')
          .select('id, full_name, email, company_id, companies(id, name)')
          .eq('id', prefillContactId)
          .single()
        if (!data) return
        const company = (data as any).companies as { id: string; name: string } | null
        if (company) {
          setSelectedCompany({ id: company.id, name: company.name })
          setCompanySearch(company.name)
        } else {
          setIsIndividual(true)
        }
      } else if (prefillCompanyId) {
        const { data } = await supabase
          .from('companies')
          .select('id, name')
          .eq('id', prefillCompanyId)
          .single()
        if (!data) return
        setSelectedCompany({ id: data.id, name: data.name })
        setCompanySearch(data.name)
      }
    }
    applyPrefill()
    // Intentionally run once on mount — consumers read the prefill refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Re-apply paste-staged new contact on every effect pass. The
    // ref is sticky (not consumed here) so it survives identity
    // flips — the designer can untick "No company" after a paste of
    // a no-org customer without losing the prefilled name + email,
    // and can pick or change a company afterwards without the flip
    // wiping their data. Cleared only by selectContact (real contact
    // picked) / clearContact (designer reset) / unmount on submit.
    if (pendingPasteNewContactRef.current) {
      setAddingContact(true)
      setNewContactName(pendingPasteNewContactRef.current.name)
      setNewContactEmail(pendingPasteNewContactRef.current.email)
    }

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

      // Apply pending contact prefill if it belongs to this company
      if (pendingContactPrefillRef.current) {
        const match = contacts.find(c => c.id === pendingContactPrefillRef.current)
        pendingContactPrefillRef.current = null
        if (match) {
          setSelectedContact(match)
          setContactSearch(match.full_name)
          return
        }
      }

      // Paste-staged new contact is now re-applied at the top of the
      // effect (sticky ref), so no consumption needed here. If the
      // ref is set we've already set addingContact=true; the
      // branches below still need to respect that. contacts.length
      // === 0 is a no-op when addingContact is already true.

      if (contacts.length === 0) {
        // Nothing to choose from — drop straight into the add-new form
        setAddingContact(true)
        return
      }

      // If we prefilled the company but not a contact, open the picker so the
      // designer can immediately choose the person.
      if (pendingFocusContactRef.current) {
        pendingFocusContactRef.current = false
        setContactOpen(true)
        setTimeout(() => contactInputRef.current?.focus(), 0)
      }
    }

    load()
  }, [selectedCompany?.id, isIndividual])

  // Trigger a Help Scout lookup whenever a contact's email becomes known.
  // Selected contact: their email. New contact: only after the designer
  // enters a valid-looking email (on blur, handled below) — we don't hit
  // the endpoint on every keystroke.
  useEffect(() => {
    if (!selectedContact) return
    runHelpscoutLookup(selectedContact.email)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContact?.id])

  async function runHelpscoutLookup(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
    if (email === hsLookupEmail) return // already done for this address
    setHsLookupEmail(email)
    setHsLookupError(null)
    setHsLookupInFlight(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('match-helpscout-conversation', {
        body: { email },
      })
      if (fnError) throw new Error(fnError.message || 'Help Scout lookup failed')
      const matches: HelpScoutMatch[] = (data?.matches ?? []) as HelpScoutMatch[]
      if (matches.length === 0) {
        // Previously silently cleared. New rule: surface the override
        // panel so the designer has to justify the missing link.
        if (hsConversationId) setHelpscoutUrl('')
        clearHelpscoutLink()
        setHsLookupReturnedZero(true)
      } else if (matches.length === 1) {
        applyHelpscoutMatch(matches[0])
      } else {
        setHsPickerMatches(matches)
        setHsPickerOpen(true)
        setHsLookupReturnedZero(false)
        setOverrideReason('')
      }
    } catch (err) {
      setHsLookupError((err as Error).message)
      // Clear the per-email dedupe key so a retry against the
      // same email actually re-hits the edge function. Without
      // this, a transient network/CORS failure pinned the email
      // and silently swallowed every subsequent attempt for
      // the same contact.
      setHsLookupEmail(null)
    } finally {
      setHsLookupInFlight(false)
    }
  }

  function applyHelpscoutMatch(m: HelpScoutMatch) {
    setHsConversationId(String(m.id))
    setHsLinkedSubject(m.subject ?? `Conversation #${m.id}`)
    setHelpscoutUrl(m.url)
    setHsPickerOpen(false)
    setHsPickerMatches([])
    setHsLookupReturnedZero(false)
    setOverrideReason('')
    setUrlFormatError(null)
  }

  function clearHelpscoutLink() {
    setHsConversationId(null)
    setHsLinkedSubject(null)
    // Don't wipe helpscoutUrl — it may contain a manually-pasted value.
    setHsPickerOpen(false)
    setHsPickerMatches([])
  }

  // Designer picked the "these aren't right" escape hatch on the
  // multi-match picker. Drop the picker, clear any link state, and
  // reveal the override panel.
  function useOverrideInsteadOfPicker() {
    clearHelpscoutLink()
    setHelpscoutUrl('')
    setHsLookupReturnedZero(true)
  }

  // ── Paste flow ─────────────────────────────────────────────────────────────

  // Parse the pasted input into either a big-id or a short-number
  // lookup. Short URL and long URL both have the big-id as the first
  // path segment after /conversation/; bare numeric input with <= 8
  // digits is treated as a short number; longer bare numeric is
  // treated as a big id directly.
  function parsePasteInput(raw: string): { conversationId?: string; conversationNumber?: string } | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const urlMatch = /^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)/.exec(trimmed)
    if (urlMatch) return { conversationId: urlMatch[1] }
    if (/^\d+$/.test(trimmed)) {
      // Heuristic: HS big-ids are ~10 digits, short numbers ~6.
      // Treat <= 8 as short, otherwise big. Saves a round-trip when
      // the designer pastes either shape.
      if (trimmed.length <= 8) return { conversationNumber: trimmed }
      return { conversationId: trimmed }
    }
    return null
  }

  async function handlePasteLookup() {
    const parsed = parsePasteInput(pasteInput)
    setPasteError(null)
    if (!parsed) {
      setPasteError('Paste a Help Scout conversation URL or the conversation number.')
      return
    }
    setPasteInFlight(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('lookup-helpscout-conversation', {
        body: parsed,
      })
      if (fnError) {
        // FunctionsHttpError wraps a Response on `.context` that
        // carries the function's own JSON error body (e.g. "No Help
        // Scout conversation found with number 420859."). Read it
        // so the designer sees something actionable rather than the
        // stock "Edge Function returned a non-2xx status code".
        let friendly = 'Help Scout lookup failed, please try again or enter details manually.'
        try {
          const ctx = (fnError as { context?: unknown }).context
          if (ctx instanceof Response) {
            const body = await ctx.clone().json()
            if (body && typeof body.error === 'string' && body.error.trim()) {
              friendly = body.error
            }
          }
        } catch {
          // fall through to the friendly default
        }
        setPasteError(friendly)
        setPasteInFlight(false)
        return
      }
      if (!data || data.error) {
        setPasteError(data?.error ?? 'Help Scout lookup failed, please try again or enter details manually.')
        setPasteInFlight(false)
        return
      }
      if (!data.customer) {
        setPasteError('Found the conversation but it has no primary customer attached. Fix that in Help Scout, or enter details manually below.')
        setPasteInFlight(false)
        return
      }
      await applyPasteResult(data)
    } catch (e) {
      setPasteError((e as Error).message || 'Help Scout lookup failed, please try again or enter details manually.')
    } finally {
      setPasteInFlight(false)
    }
  }

  // Apply a successful paste lookup to the form state. Pre-fills:
  //   * HS link (conversation id + canonical URL)
  //   * Company (by case-insensitive name match; or "new" if unknown)
  //   * Contact (by email match across all companies; or "adding new"
  //     with pre-filled name + email)
  async function applyPasteResult(result: {
    id: number
    number: number
    url: string
    subject: string | null
    customer: { id: number; firstName: string; lastName: string; email: string; organization: string | null; createdAt: string | null }
  }) {
    // HS state
    setHelpscoutUrl(result.url)
    setHsConversationId(String(result.id))
    setHsLinkedSubject(result.subject ?? `Conversation #${result.number}`)
    setHsLookupReturnedZero(false)
    setOverrideReason('')
    setUrlFormatError(null)
    setPasteSubject(result.subject ?? null)
    setCustomerCreatedAt(result.customer.createdAt)

    // Auto-expand the manual details disclosure so the designer can
    // review what landed.
    setManualOpen(true)

    const email = result.customer.email.trim().toLowerCase()
    const displayName = titleCase(`${result.customer.firstName} ${result.customer.lastName}`.trim())
    const organization = result.customer.organization?.trim()

    // Look up an existing contact by email, cross-company.
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id, full_name, email, company_id, companies(id, name)')
      .eq('email', email)
      .maybeSingle()

    if (existingContact) {
      const company = (existingContact as any).companies as { id: string; name: string } | null
      if (company) {
        setSelectedCompany({ id: company.id, name: company.name })
        setCompanySearch(company.name)
        setIsIndividual(false)
      } else {
        setIsIndividual(true)
        setSelectedCompany(null)
      }
      pendingContactPrefillRef.current = (existingContact as any).id
      // The contact-load effect re-runs on the selectedCompany change
      // and will apply the pendingContactPrefillRef once contacts
      // arrive.
      return
    }

    // No existing contact — stage a new one via the ref, then resolve
    // the company so the contact-load effect fires with the right
    // companyId.
    pendingPasteNewContactRef.current = { name: displayName, email }

    if (!organization) {
      setIsIndividual(true)
      setSelectedCompany(null)
      return
    }

    const casedCompany = titleCase(organization)
    const { data: existingCompany } = await supabase
      .from('companies')
      .select('id, name')
      .ilike('name', organization)
      .limit(1)
      .maybeSingle()

    if (existingCompany) {
      setSelectedCompany({ id: (existingCompany as any).id, name: (existingCompany as any).name })
      setCompanySearch((existingCompany as any).name)
    } else {
      setSelectedCompany({ id: null, name: casedCompany })
      setCompanySearch(casedCompany)
    }
    setIsIndividual(false)
  }

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
    // Manual pick breaks association with any pasted HS customer,
    // so the "Customer since" subtitle no longer applies.
    setCustomerCreatedAt(null)
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
    setCustomerCreatedAt(null)
  }

  function handleIndividualToggle(checked: boolean) {
    setIsIndividual(checked)
    if (checked) {
      setSelectedCompany(null)
      setCompanySearch('')
      setCompanyOpen(false)
      setCustomerCreatedAt(null)
    }
  }

  // ── Contact handlers ───────────────────────────────────────────────────────

  function selectContact(c: Contact) {
    // Picking a real contact supersedes any paste-staged new
    // contact — clear the sticky ref so later identity flips don't
    // re-apply the stale paste data on top of the chosen contact.
    pendingPasteNewContactRef.current = null
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
    // Designer explicitly abandoned the staged contact — drop the
    // paste-staged ref so it doesn't re-apply on the next effect
    // pass when the contact-load effect's resets wipe the form.
    pendingPasteNewContactRef.current = null
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

    // Helper: surface a manual-section validation error AND expand
    // the disclosure if it's still collapsed, so the field the
    // designer is being told to fill is actually on screen. The
    // Help Scout lookup flow already calls setManualOpen(true) on
    // success; this mirrors that for the validation-failure path.
    //
    // Scroll target is the section that owns the failing field —
    // without it, the form-level error banner renders at the top
    // of the page while the offending field can be far below.
    // requestAnimationFrame defers until after the manual section
    // has expanded so the scroll lands on a mounted element.
    const failManual = (msg: string, target?: RefObject<HTMLElement | null>) => {
      setError(msg)
      setManualOpen(true)
      if (target) {
        requestAnimationFrame(() => {
          target.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      }
    }

    if (!isIndividual && !selectedCompany) {
      failManual('Please select or add a company, or tick "No company".', companyRef)
      return
    }
    if (!isIndividual && selectedCompany && selectedCompany.id === null && !selectedCompany.name.trim()) {
      failManual('Company name is required.', companyRef)
      return
    }
    if (!selectedContact && !addingContact) {
      failManual('Please select or add a contact.', contactRef)
      return
    }
    if (addingContact) {
      if (!newContactName.trim()) { failManual('Contact full name is required.', contactRef); return }
      if (!newContactEmail.trim()) { failManual('Contact email is required.', contactRef); return }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContactEmail.trim())) {
        failManual('Please enter a valid email address.', contactRef)
        return
      }
    }

    // Help Scout: require either a valid conversation URL or a
    // sufficiently-long override reason. Mirrors the DB check
    // constraint, with URL format validation on top.
    const typedUrl = helpscoutUrl.trim()
    const parsedUrl = typedUrl ? parseHelpscoutUrl(typedUrl) : null
    const reason = overrideReason.trim()
    const scrollToHelpscout = () => {
      requestAnimationFrame(() => {
        helpscoutSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
    if (typedUrl && !parsedUrl) {
      setError('The Help Scout URL is invalid. Expected https://secure.helpscout.net/conversation/<id>.')
      scrollToHelpscout()
      return
    }
    if (!parsedUrl && reason.length < MIN_OVERRIDE_REASON_LENGTH) {
      setError(`Pick a Help Scout conversation, or provide an override reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.`)
      scrollToHelpscout()
      return
    }

    setSubmitting(true)
    try {
      // 1. Create company if it's new
      let companyId: string | null = null
      if (!isIndividual) {
        if (selectedCompany!.id === null) {
          const insertedName = selectedCompany!.name.trim()
          const { data, error } = await supabase
            .from('companies')
            .insert({ name: insertedName })
            .select('id')
            .single()
          if (error) {
            if (error.code === '23505') {
              throw new Error(`A company called "${selectedCompany!.name}" already exists.`)
            }
            throw new Error(`Failed to create company: ${error.message}`)
          }
          companyId = data.id
          // Promote selectedCompany from { id: null, name } (staged) to
          // the DB-backed { id, name } pair. Without this, a partial-
          // success retry (e.g. the contact insert below fails and the
          // designer fixes a field and re-submits) re-enters the
          // company-insert branch with the same name and hits 23505 —
          // the row already exists in the DB even though the React
          // state still says id=null. Pairs with the setAllCompanies
          // append from #45.
          setSelectedCompany({ id: data.id, name: insertedName })
          // Append to the locally-cached company list so the picker
          // reflects reality if the designer stays on the form (e.g.
          // a downstream contact / proof insert fails and they retry).
          // The on-mount fetch loads .order('name'); preserve the same
          // order on local insert. setAllCompanies is a no-op for the
          // happy path since navigate() unmounts the form, but the
          // cost is negligible and keeps the state honest if the
          // happy path ever changes.
          setAllCompanies(prev =>
            [...prev, { id: data.id, name: insertedName }]
              .sort((a, b) => a.name.localeCompare(b.name)),
          )
          void logAudit({
            action: 'company.created',
            targetType: 'company',
            targetId: companyId,
            targetLabel: insertedName,
          })
        } else {
          companyId = selectedCompany!.id
        }
      }

      // 2. Create contact if it's new
      let contactId: string
      if (selectedContact) {
        contactId = selectedContact.id
      } else {
        const insertedFullName = newContactName.trim()
        const insertedEmail = newContactEmail.trim().toLowerCase()
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            company_id: companyId,
            full_name: insertedFullName,
            email: insertedEmail,
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
        // Append to the locally-cached contact list so the picker
        // reflects reality if the designer stays on the form (e.g.
        // the downstream proof insert fails and they retry). Mirror
        // the company append from #45: the on-load effect uses
        // .order('full_name'), so insert sorted by full_name.
        // Like the company append, this is a no-op on the happy
        // path (navigate() unmounts the form), but it keeps the
        // state honest in the partial-success retry window.
        //
        // selectedContact is intentionally *not* promoted here.
        // Unlike the company branch, the form is in add-mode at
        // this point (selectedContact === null, addingContact ===
        // true). On retry, the submit handler's `if (selectedContact)`
        // short-circuit doesn't engage; the insert branch re-fires
        // with the same email and hits 23505 deterministically. To
        // make retries idempotent we'd also need to flip the form
        // out of add-mode and call selectContact(...) — that's a
        // larger UX change (the add-mode form fields would
        // collapse mid-edit) and warrants its own design pass.
        // The append below at least prevents the retry from picking
        // a *different* duplicate-email row by surfacing the new
        // contact as a real picker option, which is the
        // companion-to-fix-1 hygiene this PR is scoped to.
        setAllContacts(prev =>
          [...prev, { id: data.id, full_name: insertedFullName, email: insertedEmail }]
            .sort((a, b) => a.full_name.localeCompare(b.full_name)),
        )
        void logAudit({
          action: 'contact.created',
          targetType: 'contact',
          targetId: contactId,
          targetLabel: insertedFullName,
          metadata: { email: insertedEmail, company_id: companyId },
        })
      }

      // 3. Create proof. Insert either a link (conversation_id + URL
      // mirrored to the legacy thread_url column) or an override
      // reason — never both, never neither (DB check constraint
      // enforces the latter).
      const resolvedConvoId = parsedUrl?.id ?? null
      const resolvedConvoUrl = parsedUrl?.url ?? null
      const resolvedOverride = resolvedConvoId ? null : reason
      const { data, error } = await supabase
        .from('proofs')
        .insert({
          contact_id: contactId,
          helpscout_thread_url:        resolvedConvoUrl,
          helpscout_conversation_id:   resolvedConvoId,
          helpscout_conversation_url:  resolvedConvoUrl,
          helpscout_override_reason:   resolvedOverride,
          internal_notes:              internalNotes.trim() || null,
          created_by:                  session!.user.id,
        })
        .select('id')
        .single()

      if (error) throw new Error(`Failed to create proof: ${error.message}`)
      void logAudit({
        action: 'proof.created',
        targetType: 'proof',
        targetId: data.id,
        targetLabel: selectedContact?.full_name ?? newContactName.trim(),
        metadata: { contact_id: contactId, company_id: companyId },
      })
      if (resolvedConvoId) {
        void logAudit({
          action: 'proof.helpscout_link_set',
          targetType: 'proof',
          targetId: data.id,
          targetLabel: selectedContact?.full_name ?? newContactName.trim(),
          metadata: {
            helpscout_conversation_id:  resolvedConvoId,
            helpscout_conversation_url: resolvedConvoUrl,
            source: pasteSubject != null
              ? 'paste'
              : hsPickerMatches.length > 0
                ? 'picker'
                : hsLookupEmail
                  ? 'auto'
                  : 'manual',
          },
        })
      } else if (resolvedOverride) {
        void logAudit({
          action: 'proof.helpscout_override_set',
          targetType: 'proof',
          targetId: data.id,
          targetLabel: selectedContact?.full_name ?? newContactName.trim(),
          metadata: {
            reason: resolvedOverride,
            lookup_email: hsLookupEmail,
          },
        })
      }
      navigate(`/proofs/${data.id}`)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-gray-50">
      <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">

        {/* Back + Quote compiler. QuoteLink lives in the per-page
            header on six pages today. Future "extract shared header"
            pass should inline this once and remove the per-page
            insertions. */}
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to projects</Link>
          <QuoteLink variant="inline" />
        </div>

        <h1 className="mb-8 text-2xl font-bold text-gray-900">New project</h1>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* ── Paste from Help Scout (primary entry point) ───────────────── */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">
              Start from Help Scout
            </h2>
            <p className="mb-3 text-xs text-gray-500">
              Paste the conversation URL or number from Help Scout. We'll pull the customer and company across.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={pasteInput}
                onChange={(e) => { setPasteInput(e.target.value); setPasteError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handlePasteLookup() } }}
                placeholder="https://secure.helpscout.net/conversation/… or 420859"
                disabled={pasteInFlight}
                className={inputClass + ' sm:flex-1'}
              />
              <button
                type="button"
                onClick={() => void handlePasteLookup()}
                disabled={pasteInFlight || !pasteInput.trim()}
                className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {pasteInFlight ? 'Looking up…' : 'Look up'}
              </button>
            </div>
            {pasteError && (
              <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{pasteError}</p>
            )}
            {pasteSubject && !pasteError && (
              <p className="mt-2 text-xs text-emerald-700">
                Found: <span className="font-medium">{pasteSubject}</span>. Review the details below.
              </p>
            )}
          </section>

          {/* Disclosure toggle — hidden when paste lands something, so
              the designer lands straight on the review. Otherwise the
              pickers below sit behind a small toggle. */}
          {!manualOpen && (
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              className="text-sm text-gray-500 underline hover:text-gray-900"
            >
              Or enter customer details manually
            </button>
          )}

          {manualOpen && (
            <>
          {/* Review nudge above the name + company fields. */}
          <p className="text-xs text-gray-500">
            This is what the customer will see on their proof page.
          </p>

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
              <div className="mb-3 space-y-1">
                {selectedCompany.id === null ? (
                  // Staged new company: name hasn't been persisted
                  // yet, so the designer can tweak it inline. The
                  // amber surround flags "editable here"; the
                  // badge itself stays neutral grey and reads
                  // "First project" — the first project in this
                  // tool for a customer we may well have worked
                  // with for years via email.
                  <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 ring-1 ring-amber-100">
                    <input
                      type="text"
                      value={selectedCompany.name}
                      onChange={(e) => setSelectedCompany({ id: null, name: e.target.value })}
                      placeholder="Company name"
                      className="min-w-0 flex-1 rounded border border-amber-200 bg-white px-2 py-1 text-[17px] sm:text-sm font-medium text-gray-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      aria-label="Company name"
                    />
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                      First project
                    </span>
                    <button
                      type="button"
                      onClick={clearCompany}
                      className="shrink-0 text-xs text-gray-500 underline hover:text-gray-900"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  // Matched existing company: read-only. Editing
                  // the name here would rename it for every other
                  // proof that references it.
                  <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
                    <span className="text-sm font-medium text-gray-900">{selectedCompany.name}</span>
                    <button
                      type="button"
                      onClick={clearCompany}
                      className="ml-3 shrink-0 text-xs text-gray-400 underline hover:text-gray-700"
                    >
                      Change
                    </button>
                  </div>
                )}
                {/* HS customer createdAt subtitle. Muted grey, sits
                    below the pill, hidden when createdAt is missing
                    or unparseable. */}
                {(() => {
                  const year = parseCustomerSinceYear(customerCreatedAt)
                  return year ? (
                    <p className="text-xs text-gray-500">Customer since {year}</p>
                  ) : null
                })()}
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
                    ref={contactInputRef}
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
                      onBlur={() => runHelpscoutLookup(newContactEmail)}
                      placeholder="e.g. alice@acmecorp.com"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
            </section>
          )}
            </>
          )}

          {/* ── Internal fields ───────────────────────────────────────────── */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Internal</h2>

            <div ref={helpscoutSectionRef} className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Help Scout conversation URL{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                type="url"
                value={helpscoutUrl}
                onChange={(e) => {
                  const v = e.target.value
                  setHelpscoutUrl(v)
                  setUrlFormatError(null)
                  // Manual edit: re-derive the linked state from the
                  // typed value. Valid URL → populate conversation_id
                  // so the submit path treats it as a first-class
                  // link. Invalid or empty → drop any prior link.
                  const parsed = parseHelpscoutUrl(v)
                  if (parsed) {
                    setHsConversationId(parsed.id)
                    // Use the looked-up subject if we happen to have
                    // one for the same id, otherwise fall back to a
                    // generic label.
                    if (!hsLinkedSubject || hsConversationId !== parsed.id) {
                      setHsLinkedSubject(`Conversation #${parsed.id}`)
                    }
                    setHsLookupReturnedZero(false)
                  } else if (v.trim() === '') {
                    clearHelpscoutLink()
                  } else {
                    clearHelpscoutLink()
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && !parseHelpscoutUrl(v)) {
                    // Distinguish a bare numeric ID (which the
                    // paste-from-Help-Scout section accepts) from
                    // an actual format error so the designer
                    // doesn't pass it through the URL field
                    // expecting it to be linkified.
                    if (/^\d+$/.test(v)) {
                      setUrlFormatError('That looks like a conversation ID. Paste it into "Start from Help Scout" above instead, or paste the full URL here.')
                    } else {
                      setUrlFormatError('Must be a Help Scout conversation URL like https://secure.helpscout.net/conversation/12345.')
                    }
                  }
                }}
                placeholder="https://secure.helpscout.net/conversation/…"
                className={inputClass}
              />
              {hsLookupInFlight && (
                <p className="mt-1.5 text-xs text-gray-400">Checking Help Scout…</p>
              )}
              {!hsLookupInFlight && hsLinkedSubject && hsConversationId && (
                <p className="mt-1.5 text-xs text-emerald-600">
                  Linked to Help Scout thread: <span className="font-medium">{hsLinkedSubject}</span>
                </p>
              )}
              {!hsLookupInFlight && hsPickerMatches.length > 1 && !hsConversationId && (
                <button
                  type="button"
                  onClick={() => setHsPickerOpen(true)}
                  className="mt-1.5 text-xs text-amber-600 underline hover:text-amber-700"
                >
                  Multiple Help Scout threads found — choose one
                </button>
              )}
              {urlFormatError && (
                <p className="mt-1.5 text-xs text-red-600">{urlFormatError}</p>
              )}
              {hsLookupError && (
                <p className="mt-1.5 text-xs text-gray-400">
                  Couldn't check Help Scout — {hsLookupError}. Paste a URL manually or provide an override reason.
                </p>
              )}
            </div>

            {/* Override reason panel. Shown when a lookup came back
                with zero matches or the designer clicked "these aren't
                right" on the picker. Must be at least
                MIN_OVERRIDE_REASON_LENGTH chars to submit. */}
            {hsLookupReturnedZero && !hsConversationId && (
              <div className="mb-4 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-100">
                <p className="text-sm font-medium text-amber-900">
                  No Help Scout conversation linked
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  {hsLookupEmail
                    ? `No matches found for ${hsLookupEmail}.`
                    : ''}{' '}
                  Paste a conversation URL above, or provide a reason to continue without one.
                </p>
                <label className="mt-3 block text-xs font-medium text-amber-900">
                  Why is this proof not linked to a Help Scout conversation? <span className="text-red-500">*</span>
                </label>
                <textarea
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder={`At least ${MIN_OVERRIDE_REASON_LENGTH} characters.`}
                  className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[17px] sm:text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <p className="mt-1 text-xs text-amber-700">
                  {overrideReason.trim().length < MIN_OVERRIDE_REASON_LENGTH
                    ? `${overrideReason.trim().length} / ${MIN_OVERRIDE_REASON_LENGTH} characters`
                    : 'OK'}
                </p>
              </div>
            )}

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

          {/* Disable while either Help Scout lookup is in flight —
              not just `submitting`. Pre-fix, clicking Create project
              before the paste lookup resolved triggered the validation
              path with an empty form, which auto-opened the manual
              disclosure (failManual → setManualOpen(true)) and showed
              a "select a company" error before the lookup had a chance
              to populate fields. Read by the user as a silent form
              reset. The `hsLookupInFlight` arm covers the secondary
              email-driven lookup that fires after a contact is
              selected — same shape of race against unpopulated fields.
              "Looking up…" mirrors the Look up button's busy copy so
              the visual language is consistent across both. */}
          <button
            type="submit"
            disabled={submitting || pasteInFlight || hsLookupInFlight}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting
              ? 'Creating…'
              : (pasteInFlight || hsLookupInFlight)
                ? 'Looking up…'
                : 'Create project'}
          </button>
        </form>
      </div>

      {hsPickerOpen && (
        <HelpScoutPicker
          matches={hsPickerMatches}
          onPick={(m) => applyHelpscoutMatch(m)}
          onOverride={() => {
            // Close picker and reveal the override-reason panel.
            // Designer must type a reason to continue; there's no
            // silent-skip path any more.
            setHsPickerOpen(false)
            setHsPickerMatches([])
            useOverrideInsteadOfPicker()
          }}
          onClose={() => setHsPickerOpen(false)}
        />
      )}
    </div>
  )
}

function HelpScoutPicker({
  matches,
  onPick,
  onOverride,
  onClose,
}: {
  matches: HelpScoutMatch[]
  onPick: (m: HelpScoutMatch) => void
  onOverride: () => void
  onClose: () => void
}) {
  // Esc + first-focusable auto-focus owned by Modal.
  return (
    <Modal
      open
      onClose={onClose}
      ariaLabelledBy="hs-picker-title"
      backdropClassName="bg-black/40"
    >
      <h3 id="hs-picker-title" className="text-sm font-semibold text-gray-900">Multiple Help Scout threads found</h3>
      <p className="mt-1 text-xs text-gray-500">Pick the conversation this proof relates to.</p>
      <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
        {matches.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onPick(m)}
            className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-gray-200 px-3 py-2.5 text-left text-sm hover:bg-gray-50 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          >
            <span className="font-medium text-gray-900">{m.subject ?? `Conversation #${m.id}`}</span>
            <span className="text-xs text-gray-500">
              <span className={m.status === 'active' ? 'font-medium text-emerald-600' : 'text-gray-500'}>
                {m.status ?? 'unknown'}
              </span>
              {m.mailboxName && ` · ${m.mailboxName}`}
              {m.modifiedAt && ` · ${new Date(m.modifiedAt).toLocaleDateString('en-GB')}`}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onOverride}
          className="text-xs text-gray-500 underline hover:text-gray-900"
        >
          These aren't right — I'll provide a reason
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
        >
          Close
        </button>
      </div>
    </Modal>
  )
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'

// Pull a four-digit year out of a Help Scout createdAt timestamp.
// Returns null for missing input, unparseable strings, or nonsense
// years (< 1900) so the "Customer since" subtitle hides silently
// rather than rendering "Customer since NaN".
function parseCustomerSinceYear(createdAt: string | null): number | null {
  if (!createdAt) return null
  const d = new Date(createdAt)
  const y = d.getFullYear()
  return Number.isFinite(y) && y >= 1900 ? y : null
}
