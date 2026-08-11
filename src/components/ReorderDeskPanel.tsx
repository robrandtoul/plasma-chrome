import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Repeat } from 'lucide-react'
import { supabase } from '../lib/supabase'
import CollapsibleSidebarPanel from './CollapsibleSidebarPanel'
import Modal from './Modal'
import MessageSendPanel from './MessageSendPanel'
import { firstName } from '../lib/firstName'
import { customerProofPath } from '../lib/customerProofUrl'
import {
  closeProspectQuietly,
  fetchDeskData,
  getReorderDeskSettings,
  markProspectContactedManually,
  planDesk,
  promoteProspects,
  multiRecipientNote,
  putBackProspect,
  recordFollowUpSent,
  skipProspect,
  startProspect,
  syncProspectOutcomes,
  todayIsoLocal,
  type DeskPlan,
  type ReorderProspect,
} from '../lib/reorderDesk'

// The Reorder desk (migration 000389): a small daily worklist of past
// customers most likely to need a top-up, served from the scored register.
// The panel owns its own queries (the register lives outside the dashboard
// working set) and follows the AwaitingPaymentPanel wake-resync pattern so a
// long-lived PWA tab stays honest. Everything here is human-triggered —
// the desk never emails anyone by itself.
//
// Bucket model (planDesk in src/lib/reorderDesk.ts):
//   Today       — the day's servings; Start builds their project.
//   In build    — started, not yet sent; finish or put back.
//   Follow-ups  — opened the page, went quiet; ONE personal note, sent here.
//   No response — never opened, window passed; closed quietly, no email.

interface FollowUpModalState {
  prospect: ReorderProspect
  proofId: string
  versionId: string
  versionNumber: number
  hasConversation: boolean
  context: Record<string, string | number | null>
}

export default function ReorderDeskPanel() {
  const navigate = useNavigate()
  const [plan, setPlan] = useState<DeskPlan | null>(null)
  const [contactedThisWeek, setContactedThisWeek] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Register rows whose email never resolved from Xero: Start reveals a small
  // inline field so the designer can paste one (Help Scout and Xero have it).
  const [emailPromptId, setEmailPromptId] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState('')
  const [followUpModal, setFollowUpModal] = useState<FollowUpModalState | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const settings = await getReorderDeskSettings()
      const data = await fetchDeskData()
      const today = todayIsoLocal()
      let next = planDesk(
        data.prospects,
        data.proofFacts,
        today,
        settings.dailyLimit,
        settings.followupDays,
        // The recency guard. Omitting this fails OPEN — an empty set holds
        // nobody back — which is why planDesk requires it rather than
        // defaulting it.
        data.recentlyActive,
      )
      if (next.promote.length > 0) {
        await promoteProspects(next.promote.map((p) => p.id), today)
      }
      // Outcomes the rest of the system already decided (approved elsewhere,
      // abandoned elsewhere) reconcile in the background; they render in
      // their new state on the next load rather than blocking this one.
      void syncProspectOutcomes(next)
      setPlan(next)
      setContactedThisWeek(data.contactedThisWeek)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the desk.')
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    // Wake-resync: a backgrounded PWA tab keeps the page in memory but drops
    // its connections; returning must refetch or the desk drifts.
    const onWake = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [load])

  async function handleStart(p: ReorderProspect) {
    // The typed draft belongs ONLY to the row whose prompt is open — a
    // leftover draft must never silently attach to a different customer.
    const email = p.email ?? (emailPromptId === p.id ? emailDraft.trim() : '')
    if (!email) {
      setEmailPromptId(p.id)
      setEmailDraft('')
      return
    }
    setBusyId(p.id)
    try {
      const { contactId } = await startProspect(p, email)
      setEmailPromptId(null)
      setEmailDraft('')
      navigate(`/proofs/new?contactId=${contactId}&reengageProspectId=${p.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start this customer.')
      setBusyId(null)
    }
  }

  async function handleAction(id: string, fn: () => Promise<void>) {
    setBusyId(id)
    // Any action retires the email prompt — its draft must not outlive the
    // row it was typed for.
    if (emailPromptId === id) {
      setEmailPromptId(null)
      setEmailDraft('')
    }
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t save — try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function openFollowUp(p: ReorderProspect) {
    if (!p.proof_id) return
    setBusyId(p.id)
    try {
      const [{ data: proof, error: proofErr }, { data: version, error: verErr }] = await Promise.all([
        supabase
          .from('proofs')
          .select('id, helpscout_conversation_id, contacts(full_name, companies(name))')
          .eq('id', p.proof_id)
          .single(),
        supabase
          .from('proof_versions')
          .select('id, version_number')
          .eq('proof_id', p.proof_id)
          .eq('is_current', true)
          .single(),
      ])
      if (proofErr) throw proofErr
      if (verErr) throw verErr
      const contact = (proof as any)?.contacts
      const fullName: string = contact?.full_name ?? p.customer_name
      setFollowUpModal({
        prospect: p,
        proofId: p.proof_id,
        versionId: version.id,
        versionNumber: version.version_number,
        hasConversation: !!(proof as any)?.helpscout_conversation_id,
        context: {
          first_name: firstName(fullName),
          full_name: fullName,
          company: contact?.companies?.name ?? null,
          version_number: version.version_number,
          url: `${window.location.origin}${customerProofPath(p.proof_id)}`,
          designer_first_name: '',
        },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the follow-up.')
    } finally {
      setBusyId(null)
    }
  }

  const actionBtn =
    'text-[12px] font-semibold text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] disabled:opacity-50'
  const quietBtn =
    'text-[12px] text-ink-mute hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] disabled:opacity-50'

  function historyLine(p: ReorderProspect): string {
    return p.score_reasons.join(' · ')
  }

  const body = (() => {
    if (error) {
      return <p className="px-5 py-6 text-center text-sm text-ink-mute">{error}</p>
    }
    if (plan == null) {
      return <p className="px-5 py-8 text-center text-sm text-ink-mute">Loading…</p>
    }
    const empty =
      plan.queue.length === 0 &&
      plan.inBuild.length === 0 &&
      plan.followUps.length === 0 &&
      plan.quietCloses.length === 0
    if (empty) {
      return (
        <p className="px-5 py-8 text-center text-sm text-ink-mute">
          All caught up — no past customers to serve today.
        </p>
      )
    }
    return (
      <div>
        <p className="px-5 pt-3 pb-1 text-[12px] text-ink-mute">
          {contactedThisWeek === 0
            ? 'No outreach sent this week yet.'
            : `${contactedThisWeek} past customer${contactedThisWeek === 1 ? '' : 's'} contacted this week.`}
        </p>

        {plan.queue.length > 0 && (
          <section aria-label="Today's past customers">
            <h3 className="px-5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              Today
            </h3>
            <ul className="divide-y divide-line-soft">
              {plan.queue.map((p) => (
                <li key={p.id} className="px-5 py-3">
                  <p className="text-sm font-semibold text-ink">{p.customer_name}</p>
                  <p className="mt-0.5 text-[12px] text-ink-mute">{historyLine(p)}</p>
                  {/* What they last bought (000393) — so whoever picks the card
                      up builds the right thing without going to Xero for it. */}
                  {p.last_spec && (
                    <p className="mt-0.5 text-[12px] text-ink-soft">Last order: {p.last_spec}</p>
                  )}
                  {/* Accounts that print for several people (000408). Shown as a
                      fact, NOT folded into the score: customers reorder because
                      they hire, not because they run out, and this is the closest
                      the invoices come to saying "this account adds people". It
                      changes the opening question from "are you due?" to "has
                      anyone joined?", which is the one the evidence supports.
                      Absent — rather than "1 person" — when the signal is either
                      unmeasured or genuinely single. */}
                  {multiRecipientNote(p) && (
                    <p className="mt-0.5 text-[12px] font-medium text-brand">{multiRecipientNote(p)}</p>
                  )}
                  {emailPromptId === p.id && !p.email && (
                    <div className="mt-2">
                      <label className="block text-[12px] text-ink-mute" htmlFor={`desk-email-${p.id}`}>
                        No email on record — paste one (it’s in Xero or Help Scout):
                      </label>
                      <input
                        id={`desk-email-${p.id}`}
                        type="email"
                        value={emailDraft}
                        onChange={(e) => setEmailDraft(e.target.value)}
                        className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-ink"
                        placeholder="name@company.com"
                      />
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-4">
                    <button
                      type="button"
                      className={actionBtn}
                      disabled={busyId === p.id}
                      onClick={() => void handleStart(p)}
                    >
                      {busyId === p.id ? 'Starting…' : 'Start their project'}
                    </button>
                    <button
                      type="button"
                      className={quietBtn}
                      disabled={busyId === p.id}
                      onClick={() => void handleAction(p.id, () => skipProspect(p.id, 'later'))}
                    >
                      Not now
                    </button>
                    <button
                      type="button"
                      className={quietBtn}
                      disabled={busyId === p.id}
                      onClick={() => void handleAction(p.id, () => skipProspect(p.id, 'never'))}
                    >
                      Never
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {plan.inBuild.length > 0 && (
          <section aria-label="Projects being built">
            <h3 className="px-5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              In build
            </h3>
            <ul className="divide-y divide-line-soft">
              {plan.inBuild.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.customer_name}</p>
                    <p className="text-[12px] text-ink-mute">Project started — build and send the note.</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {p.proof_id && (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => navigate(`/proofs/${p.proof_id}`)}
                      >
                        Open
                      </button>
                    )}
                    <button
                      type="button"
                      className={quietBtn}
                      disabled={busyId === p.id}
                      title="If you sent the note outside the app (a fresh Help Scout conversation, a plain email), record it here so the follow-up clock starts."
                      onClick={() =>
                        void handleAction(p.id, () => markProspectContactedManually(p.id))
                      }
                    >
                      Sent it myself
                    </button>
                    <button
                      type="button"
                      className={quietBtn}
                      disabled={busyId === p.id}
                      onClick={() => void handleAction(p.id, () => putBackProspect(p.id))}
                    >
                      Put back
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {plan.followUps.length > 0 && (
          <section aria-label="Follow-ups due">
            <h3 className="px-5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              Opened, gone quiet
            </h3>
            <ul className="divide-y divide-line-soft">
              {plan.followUps.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.customer_name}</p>
                    <p className="text-[12px] text-ink-mute">
                      They opened their page — one personal follow-up, then we leave them be.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={actionBtn}
                    disabled={busyId === p.id}
                    onClick={() => void openFollowUp(p)}
                  >
                    Send follow-up
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {plan.quietCloses.length > 0 && (
          <section aria-label="No response">
            <h3 className="px-5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              No response
            </h3>
            <ul className="divide-y divide-line-soft">
              {plan.quietCloses.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.customer_name}</p>
                    <p className="text-[12px] text-ink-mute">
                      {p.followed_up_at
                        ? 'No reply to the follow-up — close quietly, no email.'
                        : 'Never opened the page — close quietly, no email.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={quietBtn}
                    disabled={busyId === p.id}
                    onClick={() => void handleAction(p.id, () => closeProspectQuietly(p))}
                  >
                    Close quietly
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="h-2" />
      </div>
    )
  })()

  return (
    <>
      <CollapsibleSidebarPanel
        icon={Repeat}
        iconTint="var(--c-brand)"
        eyebrow="Back book"
        title="Reorder desk"
        storageKey="pv.sidebar.collapsed.reorder-desk"
      >
        {body}
      </CollapsibleSidebarPanel>

      {followUpModal && (
        <Modal
          open
          onClose={() => setFollowUpModal(null)}
          ariaLabel="Send re-engagement follow-up"
          panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
        >
          <MessageSendPanel
            proofId={followUpModal.proofId}
            versionId={followUpModal.versionId}
            versionNumber={followUpModal.versionNumber}
            templateId="reorder_outreach_followup"
            context={followUpModal.context}
            hasHelpScoutConversation={followUpModal.hasConversation}
            onSent={() => {
              void recordFollowUpSent(followUpModal.prospect.id).then(() => load())
              setFollowUpModal(null)
            }}
            onSkip={() => setFollowUpModal(null)}
            skipLabel="Cancel"
          />
        </Modal>
      )}
    </>
  )
}
