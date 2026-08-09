import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { snoozeProof } from '../lib/snooze'
import { OUTREACH_SNOOZE_RULES, OUTREACH_SNOOZE_HOURS } from '../lib/reorderDesk'
import { parseHelpscoutUrl, MIN_OVERRIDE_REASON_LENGTH } from '../lib/helpscout'
import { titleCase } from '../lib/titleCase'
// QuoteLink now rendered inside DesignerChrome (PR 35).
import Modal from '../components/Modal'
import ContactNameNudge from '../components/ContactNameNudge'
import { DesignerChrome, ButtonInk } from '../design'
import { ChevronRight } from 'lucide-react'

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
  // Set by the Reorder desk's Start action (000389): marks the new project as
  // re-engagement outreach so chasing is suppressed and outcomes track back
  // to the register.
  const prefillProspectId = searchParams.get('reengageProspectId')

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

  // ── Contact-name nudge ─────────────────────────────────────────────────────
  // The name Help Scout holds for the customer the paste flow just resolved.
  // Kept so that reusing an EXISTING contact can offer their fuller HS name:
  // the paste flow matches on email and reuses the stored row untouched, so a
  // contact created back when Help Scout only knew "Karen" stayed "Karen" long
  // after HS gained "Law".
  //
  // Stored WITH the email it describes, and only ever offered for a contact
  // whose email matches. Keying it on the email rather than on "whatever is
  // selected now" is load-bearing: applyPasteResult sets this before the
  // contact switch is confirmed, and the switch is delegated to the
  // contact-load effect, which silently does nothing when the pasted contact
  // isn't in the loaded company. Without the check, a paste for one Karen
  // could offer her surname for a different Karen — and the nudge writes
  // straight to a live customer row.
  const [hsCustomerName, setHsCustomerName] = useState<{ email: string; name: string } | null>(null)
  const [nameFixBusy, setNameFixBusy] = useState(false)
  const [nameFixError, setNameFixError] = useState<string | null>(null)
  // Set after a successful write so the designer can put it back. The pill is
  // the only nudge that persists instead of staging, and once a name has two
  // tokens the prompt goes silent forever — so without this, a mis-click is
  // unrecoverable for anyone who isn't an admin (the contact editor is behind
  // RequireAdmin).
  const [nameFixUndo, setNameFixUndo] = useState<{ id: string; previous: string } | null>(null)
  // Mirrors selectedContact.id for reads after an await — see applyContactNameFix.
  const selectedContactIdRef = useRef<string | null>(null)

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

  // ── Duplicate-conversation guard ───────────────────────────────────────────
  // When the chosen Help Scout conversation already backs an existing proof,
  // the first save is blocked and this holds that proof (for the warning
  // message + a link to it). Keyed on the CONVERSATION, not the contact —
  // one customer can have several genuinely separate jobs, each on its own
  // thread; reusing the same thread is the real duplicate signal (the Orama
  // case: two proofs on conversation 3355765215). `convoDupChecking` covers
  // the brief lookup so the Create button shows progress.
  const [convoDupWarning, setConvoDupWarning] = useState<{ proofId: string; label: string } | null>(null)
  const [convoDupChecking, setConvoDupChecking] = useState(false)

  // ── Paste-from-Help-Scout flow (primary entry point) ───────────────────────
  const [pasteInput, setPasteInput] = useState('')
  const [pasteInFlight, setPasteInFlight] = useState(false)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pasteSubject, setPasteSubject] = useState<string | null>(null)
  // True when the paste box was the mechanism that populated the current
  // HS link. Used to set source='paste' in the helpscout_link_set audit
  // event even when the conversation has no subject (pasteSubject would
  // be null in that case, which previously caused the source to evaluate
  // as 'auto' or 'picker' — PV-2026W20-001).
  const [pasteWasUsed, setPasteWasUsed] = useState(false)
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

  // Mirror of the selected contact's id, readable after an await. Used by
  // applyContactNameFix to tell whether the designer moved on mid-write.
  useEffect(() => {
    selectedContactIdRef.current = selectedContact?.id ?? null
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
    setPasteWasUsed(false)
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
    setPasteWasUsed(true)
    setCustomerCreatedAt(result.customer.createdAt)

    // Auto-expand the manual details disclosure so the designer can
    // review what landed.
    setManualOpen(true)

    const email = result.customer.email.trim().toLowerCase()
    const displayName = titleCase(`${result.customer.firstName} ${result.customer.lastName}`.trim())
    const organization = result.customer.organization?.trim()

    // Remember what Help Scout calls them, so the nudge can offer it if the
    // contact we're about to reuse is stored under a barer name. Paired with
    // the email so it can never be offered for a different customer.
    setHsCustomerName({ email, name: displayName })
    setNameFixError(null)

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
    // A hand-picked contact isn't necessarily the customer the paste resolved,
    // so the remembered Help Scout name no longer describes them.
    setHsCustomerName(null)
    setNameFixError(null)
    setNameFixUndo(null)
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
    setHsCustomerName(null)
    setNameFixError(null)
    setNameFixUndo(null)
    setSelectedContact(null)
    setAddingContact(false)
    setContactSearch('')
    setNewContactName('')
    setNewContactEmail('')
  }

  // Set the new-contact name, keeping the paste-staged ref in step with it.
  //
  // The ref is sticky: the contact-load effect re-applies its {name, email} on
  // every pass so a company / individual-mode flip doesn't wipe pasted data.
  // The flip side is that it replays HELP SCOUT's name, so a designer who
  // corrects "Arnel" to "Arnel Burkic" and then ticks "No company" silently
  // gets "Arnel" back — losing the correction with nothing on screen to say so.
  // Writing the edit through to the ref makes the replay reproduce what the
  // designer actually chose.
  //
  // Deliberately name-only. The email field has the same latent staleness, but
  // it's pre-existing, and email is the key the Help Scout lookup dedupes on —
  // not somewhere to make an unrequested change.
  function updateNewContactName(name: string) {
    setNewContactName(name)
    if (pendingPasteNewContactRef.current) {
      pendingPasteNewContactRef.current = { ...pendingPasteNewContactRef.current, name }
    }
  }

  // Apply a fuller name to the ALREADY-SAVED contact behind the selected-contact
  // pill. Writes immediately rather than waiting for the proof to be created:
  // the fix is about the customer record, not this proof, and a designer who
  // then abandons the form shouldn't lose the correction. Contacts are
  // authenticated-updatable (migration 000015), so no elevated path is needed.
  async function applyContactNameFix(name: string, isUndo = false) {
    const target = selectedContact
    if (!target || nameFixBusy) return
    setNameFixBusy(true)
    setNameFixError(null)
    const { error } = await supabase
      .from('contacts')
      .update({ full_name: name })
      .eq('id', target.id)
    setNameFixBusy(false)
    if (error) {
      setNameFixError(`Couldn't update the name: ${error.message}`)
      return
    }

    // The contact row is corrected either way, so the cached list is always
    // refreshed — it's keyed by id, so this is right whoever is selected now.
    setAllContacts((prev) =>
      prev
        .map((c) => (c.id === target.id ? { ...c, full_name: name } : c))
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    )

    // Audited on the strength of the write, not of what the form shows — the
    // row changed regardless of who is selected by the time this resolves.
    void logAudit({
      action: 'contact.updated',
      targetType: 'contact',
      targetId: target.id,
      targetLabel: name,
      // beforeValue/afterValue, not metadata — the admin Activity viewer builds
      // its diff from those two columns and shows "No data changes recorded"
      // otherwise. Matches the emitter in CustomerDetailPage.
      beforeValue: { full_name: target.full_name },
      afterValue: { full_name: name },
    })

    // Offer the way back — except on the undo itself, which would just loop.
    setNameFixUndo(isUndo ? null : { id: target.id, previous: target.full_name })

    // Form state is a different matter. The designer can hit "Change" or pick
    // somebody else while the write is in flight, and re-selecting the contact
    // they just abandoned would do more than look odd: the Help Scout lookup
    // effect is keyed on selectedContact.id, so resurrecting a superseded
    // contact re-fires match-helpscout-conversation, which on a zero-match
    // result calls clearHelpscoutLink() and forces the override panel —
    // tearing down a Help Scout link the designer had already resolved. Only
    // touch the form when the contact is still the selected one.
    if (selectedContactIdRef.current !== target.id) return

    setSelectedContact({ ...target, full_name: name })
    setContactSearch(name)
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    await submitProof(false)
  }

  // skipConvoGuard=true is the "Create a separate proof anyway" override
  // from the duplicate-conversation warning; the normal submit passes false
  // so the guard runs.
  async function submitProof(skipConvoGuard: boolean) {
    setError('')
    setConvoDupWarning(null)

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

    // Resolve the Help Scout link once. Insert either a conversation link
    // (id + URL, URL also mirrored to the legacy thread_url column) or an
    // override reason — never both, never neither (the DB check constraint
    // enforces the latter).
    const resolvedConvoId  = parsedUrl?.id ?? null
    const resolvedConvoUrl = parsedUrl?.url ?? null
    const resolvedOverride = resolvedConvoId ? null : reason

    // Duplicate-conversation guard. A new proof keyed to a conversation that
    // already backs a proof almost always means "add a version to the
    // existing proof", not "start a second one". Block the first save and
    // point the designer at that proof; "Create a separate proof anyway"
    // (skipConvoGuard) is the explicit override for the rare distinct job
    // that genuinely shares a thread.
    if (!skipConvoGuard && resolvedConvoId) {
      setConvoDupChecking(true)
      const { data: existingProof, error: dupErr } = await supabase
        .from('proofs')
        .select('id, contacts(full_name, companies(name))')
        .eq('helpscout_conversation_id', resolvedConvoId)
        .limit(1)
        .maybeSingle()
      setConvoDupChecking(false)
      // Fail open: a lookup error must never block legitimate creation.
      if (!dupErr && existingProof) {
        const c = (existingProof as any).contacts
        const who = c?.companies?.name ?? c?.full_name ?? 'an existing customer'
        setConvoDupWarning({ proofId: (existingProof as any).id, label: who })
        scrollToHelpscout()
        return
      }
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
        // Promote selectedContact immediately so the form flips from
        // add-mode to pill-mode. This mirrors what the company branch
        // does for selectedCompany.id after a successful company insert.
        // On the happy path navigate() unmounts the form so this is a
        // no-op, but in the partial-success retry window (contact insert
        // succeeded, proof insert failed) it prevents the retry from
        // re-attempting the contact insert and hitting 23505.
        const newContact: Contact = { id: data.id, full_name: insertedFullName, email: insertedEmail }
        setSelectedContact(newContact)
        setAddingContact(false)
        setAllContacts(prev =>
          [...prev, newContact].sort((a, b) => a.full_name.localeCompare(b.full_name)),
        )
        void logAudit({
          action: 'contact.created',
          targetType: 'contact',
          targetId: contactId,
          targetLabel: insertedFullName,
          metadata: { email: insertedEmail, company_id: companyId },
        })
      }

      // 3. Create proof, using the Help Scout link resolved above.
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
          // Reorder-desk outreach: mark origin + switch off auto-chasing at
          // birth (000389) — the desk's own lifecycle chases instead, and the
          // standard reminder wording presumes the customer asked for the work.
          ...(prefillProspectId
            ? {
                reengagement_prospect_id: prefillProspectId,
                auto_nudge_disabled_at: new Date().toISOString(),
              }
            : {}),
        })
        .select('id')
        .single()

      if (error) {
        // The partial unique index on reengagement_prospect_id (000391) makes
        // a duplicated Start link fail loudly rather than minting a second
        // outreach proof for the same customer.
        if (error.code === '23505' && error.message.includes('proofs_reengagement_prospect_unique')) {
          throw new Error(
            'An outreach project already exists for this customer — open it from the Reorder desk instead of creating another.',
          )
        }
        throw new Error(`Failed to create proof: ${error.message}`)
      }
      void logAudit({
        action: 'proof.created',
        targetType: 'proof',
        targetId: data.id,
        targetLabel: selectedContact?.full_name ?? newContactName.trim(),
        metadata: { contact_id: contactId, company_id: companyId },
      })
      // Reorder-desk outreach (000389): snooze the chase-rule FLAGS too —
      // auto_nudge_disabled_at stops the sender, but a never-opened outreach
      // proof would otherwise clutter Needs attention within days. Engaged
      // customers re-enter normal attention automatically (the 000222 trigger
      // expires chase snoozes on approve / request_changes). Then point the
      // prospect at its new project. All best-effort: a miss costs tidiness,
      // never the project.
      if (prefillProspectId) {
        for (const rule of OUTREACH_SNOOZE_RULES) {
          try {
            await snoozeProof(
              data.id,
              rule,
              OUTREACH_SNOOZE_HOURS,
              'Re-engagement outreach — the desk manages this project',
              'reorder_desk',
            )
          } catch (e) {
            console.error('[reorder-desk] snooze failed', rule, e)
          }
        }
        // State-guarded: a stale reengageProspectId URL (restored tab,
        // browser history) must not knock an already-contacted or converted
        // prospect back to in_build.
        const { error: prospectErr } = await supabase
          .from('reorder_prospects')
          .update({ proof_id: data.id, state: 'in_build', updated_at: new Date().toISOString() })
          .eq('id', prefillProspectId)
          .in('state', ['pending', 'queued', 'in_build'])
        if (prospectErr) console.error('[reorder-desk] prospect link failed', prospectErr)
      }
      if (resolvedConvoId) {
        void logAudit({
          action: 'proof.helpscout_link_set',
          targetType: 'proof',
          targetId: data.id,
          targetLabel: selectedContact?.full_name ?? newContactName.trim(),
          metadata: {
            helpscout_conversation_id:  resolvedConvoId,
            helpscout_conversation_url: resolvedConvoUrl,
            // Picker selections clear hsPickerMatches via
            // applyHelpscoutMatch before save runs, so the
            // hsPickerMatches.length>0 branch was unreachable.
            // Picker resolutions audit as 'auto' (same as the
            // single-match auto-apply path) since both end with
            // hsLookupEmail set and the link populated.
            source: pasteWasUsed
              ? 'paste'
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
    <DesignerChrome active="proofs">
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-xl px-4 py-8 sm:px-6">

        {/* Breadcrumb — Proofs › New project. DesignerChrome carries
            QuoteLink + nav, so this row is hierarchy only. */}
        <nav className="mb-6 flex items-center gap-1.5 text-[13px]">
          <Link to="/" className="text-ink-mute hover:text-ink transition-colors">Proofs</Link>
          <ChevronRight size={14} className="text-ink-dim" aria-hidden="true" />
          <span className="text-ink-soft">New project</span>
        </nav>

        <h1 className="mb-8 font-display font-medium tracking-[-0.02em] text-ink leading-tight" style={{ fontSize: 'clamp(24px, 4vw, 32px)' }}>New project</h1>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* ── Paste from Help Scout (primary entry point) ───────────────── */}
          <section className="rounded-[14px] bg-surface p-6 border border-line">
            <h2 className="mb-1 eyebrow text-ink-mute">
              Start from Help Scout
            </h2>
            <p className="mb-3 text-xs text-ink-mute">
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
              <ButtonInk
                onClick={() => void handlePasteLookup()}
                disabled={pasteInFlight || !pasteInput.trim()}
                busy={pasteInFlight}
                className="shrink-0"
              >
                {pasteInFlight ? 'Looking up…' : 'Look up'}
              </ButtonInk>
            </div>
            {pasteError && (
              <p className="mt-2 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">{pasteError}</p>
            )}
            {pasteSubject && !pasteError && (
              <p className="mt-2 text-xs text-in-stock">
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
              className="text-sm text-ink-mute underline hover:text-ink"
            >
              Or enter customer details manually
            </button>
          )}

          {manualOpen && (
            <>
          {/* Review nudge above the name + company fields. */}
          <p className="text-xs text-ink-mute">
            This is what the customer will see on their proof page.
          </p>

          {/* ── Company ──────────────────────────────────────────────────── */}
          <section className="rounded-[14px] bg-surface p-6 border border-line">
            <h2 className="mb-4 eyebrow text-ink-mute">Company</h2>

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
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-white shadow-md">
                    {filteredCompanies.length === 0 && !companySearch.trim() && (
                      <p className="px-3 py-3 text-sm text-ink-mute">No companies yet — type to add one.</p>
                    )}
                    {filteredCompanies.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => selectCompany(c)}
                        className="flex w-full px-3 py-2.5 text-left text-sm text-ink hover:bg-canvas"
                      >
                        {c.name}
                      </button>
                    ))}
                    {companySearch.trim() && !exactCompanyMatch && (
                      <button
                        type="button"
                        onClick={addNewCompany}
                        className={[
                          'flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm text-ink-mute hover:bg-canvas',
                          filteredCompanies.length > 0 ? 'border-t border-line-soft' : '',
                        ].join(' ')}
                      >
                        <span className="text-ink-mute">+</span>
                        Add new company:{' '}
                        <span className="font-medium text-ink">"{companySearch.trim()}"</span>
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
                  <div
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5"
                    style={{
                      backgroundColor: 'var(--c-low-soft)',
                      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--c-low) 30%, transparent)',
                    }}
                  >
                    <input
                      type="text"
                      value={selectedCompany.name}
                      onChange={(e) => setSelectedCompany({ id: null, name: e.target.value })}
                      placeholder="Company name"
                      className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-[17px] sm:text-sm font-medium text-ink focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
                      aria-label="Company name"
                    />
                    <span className="shrink-0 rounded-full bg-line-soft px-2 py-0.5 text-xs font-medium text-ink-soft">
                      First project
                    </span>
                    <button
                      type="button"
                      onClick={clearCompany}
                      className="shrink-0 text-xs text-ink-mute underline hover:text-ink"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  // Matched existing company: read-only. Editing
                  // the name here would rename it for every other
                  // proof that references it.
                  <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2.5">
                    <span className="text-sm font-medium text-ink">{selectedCompany.name}</span>
                    <button
                      type="button"
                      onClick={clearCompany}
                      className="ml-3 shrink-0 text-xs text-ink-mute underline hover:text-ink-soft"
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
                    <p className="text-xs text-ink-mute">Customer since {year}</p>
                  ) : null
                })()}
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isIndividual}
                onChange={(e) => handleIndividualToggle(e.target.checked)}
                className="rounded border-line"
              />
              <span className="text-sm text-ink-soft">No company (individual)</span>
            </label>
          </section>

          {/* ── Contact (shown once company is resolved) ─────────────────── */}
          {companyResolved && (
            <section className="rounded-[14px] bg-surface p-6 border border-line">
              <h2 className="mb-4 eyebrow text-ink-mute">Contact</h2>

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
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-white shadow-md">
                      {filteredContacts.length === 0 && !contactSearch.trim() && (
                        <p className="px-3 py-3 text-sm text-ink-mute">
                          No contacts{selectedCompany?.id === null ? ' yet (new company)' : ' for this company'}.
                        </p>
                      )}
                      {filteredContacts.length === 0 && contactSearch.trim() && (
                        <p className="px-3 py-3 text-sm text-ink-mute">No matches.</p>
                      )}
                      {filteredContacts.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectContact(c)}
                          className="flex w-full flex-col px-3 py-2.5 text-left hover:bg-canvas"
                        >
                          <span className="text-sm font-medium text-ink">{c.full_name}</span>
                          <span className="text-xs text-ink-mute">{c.email}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={chooseAddContact}
                        className={[
                          'flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm text-ink-mute hover:bg-canvas',
                          filteredContacts.length > 0 ? 'border-t border-line-soft' : '',
                        ].join(' ')}
                      >
                        <span className="text-ink-mute">+</span>
                        {contactSearch.trim() ? (
                          <>
                            Add new contact:{' '}
                            <span className="font-medium text-ink">"{contactSearch.trim()}"</span>
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
                <>
                  <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2.5">
                    <div>
                      <span className="text-sm font-medium text-ink">{selectedContact.full_name}</span>
                      <span className="ml-2 text-sm text-ink-mute">{selectedContact.email}</span>
                    </div>
                    <button
                      type="button"
                      onClick={clearContact}
                      className="ml-3 shrink-0 text-xs text-ink-mute underline hover:text-ink-soft"
                    >
                      Change
                    </button>
                  </div>
                  {/* Warns even with nothing to suggest, and offers an inline
                      field: this is the screen where the designer has the Help
                      Scout thread open, and it's where every already-existing
                      contact lands — including the ones the matcher can't help
                      with. allowEdit is what makes that honest, since here
                      "apply" writes to the customer record rather than a form. */}
                  <ContactNameNudge
                    fullName={selectedContact.full_name}
                    email={selectedContact.email}
                    helpscoutName={
                      hsCustomerName &&
                      hsCustomerName.email === selectedContact.email.trim().toLowerCase()
                        ? hsCustomerName.name
                        : null
                    }
                    onApply={(name) => void applyContactNameFix(name)}
                    warnWithoutSuggestion
                    allowEdit
                    busy={nameFixBusy}
                    error={nameFixError}
                  />
                  {nameFixUndo && nameFixUndo.id === selectedContact.id && (
                    <p className="mt-2 text-xs text-ink-mute">
                      Saved as <span className="font-medium text-ink">{selectedContact.full_name}</span>.{' '}
                      <button
                        type="button"
                        onClick={() => void applyContactNameFix(nameFixUndo.previous, true)}
                        disabled={nameFixBusy}
                        className="underline hover:text-ink disabled:opacity-50"
                      >
                        Undo
                      </button>
                    </p>
                  )}
                </>
              )}

              {/* New contact inline form */}
              {addingContact && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-ink-soft">New contact</span>
                    {/* Only show Cancel when there are existing contacts to revert to */}
                    {allContacts.length > 0 && (
                      <button
                        type="button"
                        onClick={clearContact}
                        className="text-xs text-ink-mute underline hover:text-ink-soft"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                      Full name <span className="text-out">*</span>
                    </label>
                    <input
                      type="text"
                      value={newContactName}
                      onChange={(e) => updateNewContactName(e.target.value)}
                      placeholder="e.g. Alice Thompson"
                      className={inputClass}
                    />
                    {/* Warns even with no suggestion: this name is usually
                        pre-filled from Help Scout, and the designer has the
                        thread open and may simply know the surname. */}
                    <ContactNameNudge
                      fullName={newContactName}
                      email={newContactEmail}
                      onApply={updateNewContactName}
                      warnWithoutSuggestion
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                      Email <span className="text-out">*</span>
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
          <section className="rounded-[14px] bg-surface p-6 border border-line">
            <h2 className="mb-4 eyebrow text-ink-mute">Internal</h2>

            <div ref={helpscoutSectionRef} className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                Help Scout conversation URL{' '}
                <span className="text-out">*</span>
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
                <p className="mt-1.5 text-xs text-ink-mute">Checking Help Scout…</p>
              )}
              {!hsLookupInFlight && hsLinkedSubject && hsConversationId && (
                <p className="mt-1.5 text-xs text-in-stock">
                  Linked to Help Scout thread: <span className="font-medium">{hsLinkedSubject}</span>
                </p>
              )}
              {!hsLookupInFlight && hsPickerMatches.length > 1 && !hsConversationId && (
                <button
                  type="button"
                  onClick={() => setHsPickerOpen(true)}
                  className="mt-1.5 text-xs underline"
                  style={{ color: 'var(--c-low)' }}
                >
                  Multiple Help Scout threads found — choose one
                </button>
              )}
              {urlFormatError && (
                <p className="mt-1.5 text-xs text-out">{urlFormatError}</p>
              )}
              {hsLookupError && (
                <p className="mt-1.5 text-xs text-ink-mute">
                  Couldn't check Help Scout — {hsLookupError}. Paste a URL manually or provide an override reason.
                </p>
              )}
            </div>

            {/* Override reason panel. Shown when a lookup came back
                with zero matches or the designer clicked "these aren't
                right" on the picker. Must be at least
                MIN_OVERRIDE_REASON_LENGTH chars to submit. */}
            {hsLookupReturnedZero && !hsConversationId && (
              <div
                className="mb-4 rounded-lg p-4"
                style={{
                  backgroundColor: 'var(--c-low-soft)',
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--c-low) 30%, transparent)',
                }}
              >
                <p className="text-sm font-medium text-ink">
                  No Help Scout conversation linked
                </p>
                <p className="mt-1 text-xs text-ink-soft">
                  {hsLookupEmail
                    ? `No matches found for ${hsLookupEmail}.`
                    : ''}{' '}
                  Paste a conversation URL above, or provide a reason to continue without one.
                </p>
                <label className="mt-3 block text-xs font-medium text-ink-soft">
                  Why is this proof not linked to a Help Scout conversation? <span className="text-out">*</span>
                </label>
                <textarea
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder={`At least ${MIN_OVERRIDE_REASON_LENGTH} characters.`}
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm text-ink focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
                />
                <p className="mt-1 text-xs text-ink-mute">
                  {overrideReason.trim().length < MIN_OVERRIDE_REASON_LENGTH
                    ? `${overrideReason.trim().length} / ${MIN_OVERRIDE_REASON_LENGTH} characters`
                    : 'OK'}
                </p>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                Internal notes{' '}
                <span className="font-normal text-ink-mute">(optional, never shown to customers)</span>
              </label>
              <textarea
                rows={3}
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                className={inputClass}
              />
            </div>
          </section>

          {convoDupWarning && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">
                {convoDupWarning.label} already has a proof on this Help Scout conversation.
              </p>
              <p className="mt-1 text-amber-800">
                To keep every round of artwork together, open that proof and add a
                new version instead of starting a second project.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  to={`/proofs/${convoDupWarning.proofId}`}
                  className="inline-flex h-9 items-center rounded-lg bg-amber-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-amber-700"
                >
                  Open existing proof
                </Link>
                <button
                  type="button"
                  onClick={() => { setConvoDupWarning(null); void submitProof(true) }}
                  className="inline-flex h-9 items-center rounded-lg border border-amber-400 px-3 text-[13px] font-medium text-amber-900 transition-colors hover:bg-amber-100"
                >
                  Create a separate proof anyway
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-out-soft px-4 py-3 text-sm text-out">{error}</p>
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
          <ButtonInk
            type="submit"
            block
            busy={submitting || convoDupChecking || pasteInFlight || hsLookupInFlight}
            className="h-11"
          >
            {submitting
              ? 'Creating…'
              : convoDupChecking
                ? 'Checking…'
                : (pasteInFlight || hsLookupInFlight)
                  ? 'Looking up…'
                  : 'Create project'}
          </ButtonInk>
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
    </DesignerChrome>
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
      <h3 id="hs-picker-title" className="text-sm font-semibold text-ink">Multiple Help Scout threads found</h3>
      <p className="mt-1 text-xs text-ink-mute">Pick the conversation this proof relates to.</p>
      <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
        {matches.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onPick(m)}
            className="flex w-full flex-col items-start gap-0.5 rounded border border-line px-3 py-2.5 text-left text-sm hover:bg-canvas focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
          >
            <span className="font-medium text-ink">{m.subject ?? `Conversation #${m.id}`}</span>
            <span className="text-xs text-ink-mute">
              <span className={m.status === 'active' ? 'font-medium text-in-stock' : 'text-ink-mute'}>
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
          className="text-xs text-ink-mute underline hover:text-ink"
        >
          These aren't right — I'll provide a reason
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-sm text-ink-mute hover:bg-line-soft"
        >
          Close
        </button>
      </div>
    </Modal>
  )
}

const inputClass =
  'w-full rounded-[8px] border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm text-ink placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]'

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
