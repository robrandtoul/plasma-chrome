// /sets/:id — the designer workspace for a proof SET
// (bundle orders Slice 3, docs/bundle-orders-spec.md §5/§14.3).
//
// One place to author a set of cards: a shared-context header (customer,
// Help Scout conversation, currency — entered once), the list of member
// cards each with its own status, plus [+ Add a card], Preview customer
// view, and Send bundle to customer.
//
// Each card is authored with the SAME proof builder as today — a member is
// an ordinary proof, and "+ Add a card" simply creates the proof shell with
// the set's context and drops the designer into /proofs/:id/versions/new.
// The set never owns design state; it owns the shared context and the one
// customer review link (/set/:id?token=…).
//
// Send posts the review link on the Help Scout thread (the existing
// send-helpscout-reply function, template 'set_review_link') and stamps
// send-evidence (last_reply_sent_at/by) on every member's current version
// so the follow-up automation treats each card as genuinely sent. Cards
// can still be ADDED afterwards (10 Jul): the customer keeps the one link,
// and the "Send update" step (template 'bundle_update_link') announces the
// new card + stamps its send evidence. Removal stays pre-send only —
// post-send drops go through the customer's set-aside or an abandon.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  Layers,
  Plus,
  Send,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import BaseModal from '../components/Modal'
import ExistingProjectPicker from '../components/ExistingProjectPicker'
import { addCardToSet, attachProofToSet, setReviewPath, type ProofSetRow } from '../lib/proofSets'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import {
  ButtonCoral,
  ButtonGhost,
  DesignerChrome,
  Eyebrow,
  PanelShell,
  ProofStatusPill,
  type ProofStatus,
} from '../design'

interface MemberVersion {
  id: string
  proof_id: string
  version_number: number
  material_display: string
  names: string[]
  currency: string | null
  // Send evidence: the card has been announced to the customer (either by
  // the original bundle send or a later update send). Null on a card added
  // after the bundle went out = "pending an update send".
  last_reply_sent_at: string | null
}

interface MemberProof {
  id: string
  status: ProofStatus
  approved_at: string | null
  set_discarded_at: string | null
  created_at: string
  currentVersion: MemberVersion | null
  thumbUrl: string | null
  discardReason: string | null
  discardNote: string | null
}

interface SetContact {
  id: string
  full_name: string
  email: string
  companies: { name: string } | null
}

// Friendly labels for the decline-panel reason codes (matches the panel).
const DISCARD_REASON_LABELS: Record<string, string> = {
  price_too_high: 'price was more than budgeted',
  different_direction: 'wants a different design direction',
  timing: 'timing isn’t right',
  going_elsewhere: 'going a different route',
  still_thinking: 'still thinking it over',
}

export default function SetWorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useAuth()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [set, setSet] = useState<(ProofSetRow & { contacts: SetContact | null }) | null>(null)
  const [members, setMembers] = useState<MemberProof[]>([])

  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)

  // Send modal state. sentThreadRef remembers a successful Help Scout post
  // across a failed follow-up write (the sent_at lock), so a retry click
  // finishes the bookkeeping WITHOUT posting the reply a second time.
  const [sendOpen, setSendOpen] = useState(false)
  const [sendBody, setSendBody] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const sentThreadRef = useRef<number | null>(null)

  // Remove/delete confirms.
  const [removeTarget, setRemoveTarget] = useState<MemberProof | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // "Bring in an existing project" — attach one of the customer's other
  // standalone projects to this set as another card.
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoadError(null)
    const { data: setRow, error: setErr } = await supabase
      .from('proof_sets')
      .select('*, contacts(id, full_name, email, companies(name))')
      .eq('id', id)
      .maybeSingle()
    if (setErr || !setRow) {
      setLoadError(setErr?.message ?? 'This bundle doesn’t exist (it may have been deleted).')
      setLoading(false)
      return
    }

    const { data: proofRows, error: proofsErr } = await supabase
      .from('proofs')
      .select('id, status, approved_at, set_discarded_at, created_at')
      .eq('proof_set_id', id)
      .order('created_at', { ascending: true })
    if (proofsErr) {
      setLoadError(proofsErr.message)
      setLoading(false)
      return
    }

    const proofIds = (proofRows ?? []).map((p) => p.id)
    let versionsByProof = new Map<string, MemberVersion>()
    const thumbsByProof = new Map<string, string>()
    const feedbackByProof = new Map<string, { reason_code: string; note: string | null }>()

    if (proofIds.length > 0) {
      const [versionsRes, feedbackRes] = await Promise.all([
        supabase
          .from('proof_versions')
          .select('id, proof_id, version_number, material_display, names, currency, last_reply_sent_at')
          .in('proof_id', proofIds)
          .eq('is_current', true),
        supabase
          .from('proof_feedback')
          .select('proof_id, reason_code, note, created_at')
          .in('proof_id', proofIds)
          .order('created_at', { ascending: false }),
      ])
      versionsByProof = new Map(
        ((versionsRes.data ?? []) as MemberVersion[]).map((v) => [v.proof_id, v]),
      )
      for (const f of (feedbackRes.data ?? []) as Array<{ proof_id: string; reason_code: string; note: string | null }>) {
        if (!feedbackByProof.has(f.proof_id)) feedbackByProof.set(f.proof_id, f)
      }

      // One thumbnail per card: the current version's first non-QR image,
      // signed inline like the rest of the designer app.
      const versionIds = [...versionsByProof.values()].map((v) => v.id)
      if (versionIds.length > 0) {
        const { data: imgRows } = await supabase
          .from('proof_version_images')
          .select('proof_version_id, image_path, sort_order, is_qr_code')
          .in('proof_version_id', versionIds)
          .eq('is_qr_code', false)
          .order('sort_order', { ascending: true })
        const firstPathByVersion = new Map<string, string>()
        for (const img of imgRows ?? []) {
          if (!firstPathByVersion.has(img.proof_version_id)) {
            firstPathByVersion.set(img.proof_version_id, img.image_path)
          }
        }
        const paths = [...firstPathByVersion.values()]
        if (paths.length > 0) {
          const { data: signed } = await supabase.storage.from('proof-images').createSignedUrls(paths, 3600)
          const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
          for (const [versionId, path] of firstPathByVersion) {
            const url = urlByPath.get(path)
            if (!url) continue
            const proofId = [...versionsByProof.entries()].find(([, v]) => v.id === versionId)?.[0]
            if (proofId) thumbsByProof.set(proofId, url)
          }
        }
      }
    }

    setSet(setRow as ProofSetRow & { contacts: SetContact | null })
    setMembers(
      (proofRows ?? []).map((p) => {
        const fb = feedbackByProof.get(p.id)
        return {
          id: p.id,
          status: p.status as ProofStatus,
          approved_at: p.approved_at,
          set_discarded_at: p.set_discarded_at,
          created_at: p.created_at,
          currentVersion: versionsByProof.get(p.id) ?? null,
          thumbUrl: thumbsByProof.get(p.id) ?? null,
          discardReason: p.set_discarded_at ? (fb ? DISCARD_REASON_LABELS[fb.reason_code] ?? fb.reason_code : null) : null,
          discardNote: p.set_discarded_at ? (fb?.note ?? null) : null,
        }
      }),
    )
    setLoading(false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const contact = set?.contacts ?? null
  const companyName = contact?.companies?.name ?? null
  const customerLabel = companyName || contact?.full_name || 'Customer'
  const isSent = !!set?.sent_at

  const activeMembers = useMemo(() => members.filter((m) => !m.set_discarded_at && m.status !== 'abandoned'), [members])
  const approvedCount = activeMembers.filter((m) => m.status === 'approved').length
  const cardsMissingArtwork = activeMembers.filter((m) => !m.currentVersion)

  // Cards the customer hasn't been told about: added after the bundle went
  // out, so their current version carries no send evidence yet (version-less
  // new cards count too). Drives the "Send update" step.
  const unannounced = useMemo(
    () => (isSent ? activeMembers.filter((m) => !m.currentVersion?.last_reply_sent_at) : []),
    [isSent, activeMembers],
  )

  const reviewUrl = set ? `${window.location.origin}${setReviewPath(set.id, set.token)}` : ''

  // Why Send is unavailable (null = can send). Checked in order of severity.
  // Pre-send this gates the first review-link send; post-send it gates the
  // "Send update" step for later additions (same artwork rule).
  const sendBlocker = !set
    ? 'Loading'
    : isSent && unannounced.length === 0
      ? null
      : !isSent && activeMembers.length === 0
        ? 'Add at least one card before sending.'
        : cardsMissingArtwork.length > 0
          ? `Every card needs artwork first — ${cardsMissingArtwork.length === 1 ? '1 card is' : `${cardsMissingArtwork.length} cards are`} still empty.`
          : !set.helpscout_conversation_id
            ? 'No Help Scout conversation is linked — copy the review link and send it by hand.'
            : null

  // Pre-send: composes the first review-link message (set_review_link).
  // Post-send: composes the "we've added a card" update (bundle_update_link)
  // — same {url}, the customer keeps the one link.
  async function openSendModal() {
    if (!set || !contact) return
    const templateId = set.sent_at ? 'bundle_update_link' : 'set_review_link'
    // Prefer the admin-edited body when one exists (Admin → Templates);
    // fall back to the compiled default so the modal works even before the
    // seed row lands.
    const { data } = await supabase
      .from('reply_templates')
      .select('body')
      .eq('id', templateId)
      .maybeSingle()
    const template = (data?.body as string | undefined)?.trim() || DEFAULT_BODIES[templateId]
    setSendBody(
      renderTemplate(template, {
        first_name: contact.full_name.split(' ')[0] ?? contact.full_name,
        full_name: contact.full_name,
        company: companyName,
        url: reviewUrl,
      }),
    )
    setSendError(null)
    setSendOpen(true)
  }

  async function handleSend() {
    if (!set || sendBusy) return
    const isUpdate = !!set.sent_at
    // The message anchors on a member proof (send-helpscout-reply is
    // proof-scoped): the first card with artwork for the initial send, or
    // the first UNANNOUNCED card with artwork for an update — the card the
    // update is about.
    const anchor = isUpdate
      ? (unannounced.find((m) => m.currentVersion) ?? activeMembers.find((m) => m.currentVersion))
      : activeMembers.find((m) => m.currentVersion)
    if (!anchor?.currentVersion) {
      setSendError('Every card needs artwork before the bundle can be sent.')
      return
    }
    if (!sendBody.trim()) {
      setSendError('The message is empty.')
      return
    }
    setSendBusy(true)
    setSendError(null)
    try {
      // 1. Post the reply on the Help Scout thread; it stamps the anchor
      //    version's last_reply_sent_at itself. Skipped on a retry after a
      //    bookkeeping failure — the reply already landed.
      let threadId = sentThreadRef.current
      if (threadId == null) {
        const { data, error } = await supabase.functions.invoke<{ thread_id?: number; error?: string }>(
          'send-helpscout-reply',
          {
            body: {
              proof_id: anchor.id,
              version_id: anchor.currentVersion.id,
              body: sendBody,
              template_id: isUpdate ? 'bundle_update_link' : 'set_review_link',
            },
          },
        )
        if (error || !data?.thread_id) throw new Error(data?.error || error?.message || 'Send failed')
        threadId = data.thread_id
        sentThreadRef.current = threadId
      }

      const nowIso = new Date().toISOString()

      // 2. Stamp send-evidence on the other cards this message announces —
      //    every active card on the initial send, only the unannounced ones
      //    on an update (already-announced cards keep their original stamps,
      //    so their reminder history stays honest).
      const announced = isUpdate ? unannounced : activeMembers
      const otherVersionIds = announced
        .filter((m) => m.id !== anchor.id && m.currentVersion)
        .map((m) => m.currentVersion!.id)
      if (otherVersionIds.length > 0) {
        await supabase
          .from('proof_versions')
          .update({ last_reply_sent_at: nowIso, last_reply_sent_by: session?.user.id ?? null })
          .in('id', otherVersionIds)
      }

      // 3. First send: record it (sent_at = the bundle went out; later
      //    additions show as "not announced yet" until an update send).
      if (!isUpdate) {
        const { error: lockErr } = await supabase
          .from('proof_sets')
          .update({ sent_at: nowIso, updated_at: nowIso })
          .eq('id', set.id)
        if (lockErr) {
          throw new Error(
            `The link was posted on Help Scout, but the bundle couldn’t be marked as sent: ${lockErr.message}. Press Send again to finish up — the message won’t be posted twice.`,
          )
        }
      }

      void logAudit({
        action: isUpdate ? 'proof_set.update_sent' : 'proof_set.sent',
        targetType: 'proof_set',
        targetId: set.id,
        targetLabel: customerLabel,
        metadata: {
          cards: activeMembers.length,
          ...(isUpdate ? { cards_announced: announced.length } : {}),
          helpscout_thread_id: threadId,
        },
      })

      sentThreadRef.current = null
      setSendOpen(false)
      await load()
    } catch (e) {
      setSendError((e as Error).message)
    } finally {
      setSendBusy(false)
    }
  }

  async function handleAddCard() {
    if (!set || !session || busyAction) return
    setBusyAction('add')
    setActionError(null)
    try {
      const { proofId } = await addCardToSet(set.id, session.user.id)
      navigate(`/proofs/${proofId}/versions/new`)
    } catch (e) {
      setActionError((e as Error).message)
      setBusyAction(null)
    }
  }

  async function handleAttachExisting(proofId: string) {
    if (!set || attachBusy) return
    setAttachBusy(true)
    setActionError(null)
    try {
      await attachProofToSet(set.id, proofId)
      setAttachOpen(false)
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setAttachBusy(false)
    }
  }

  async function handleRemove(member: MemberProof) {
    if (!set || busyAction) return
    setBusyAction(`remove-${member.id}`)
    setActionError(null)
    const { error } = await supabase
      .from('proofs')
      .update({ proof_set_id: null, set_discarded_at: null })
      .eq('id', member.id)
    if (error) {
      setActionError(`Couldn’t remove the card: ${error.message}`)
    } else {
      void logAudit({
        action: 'proof_set.card_removed',
        targetType: 'proof_set',
        targetId: set.id,
        targetLabel: customerLabel,
        metadata: { proof_id: member.id },
      })
      await load()
    }
    setRemoveTarget(null)
    setBusyAction(null)
  }

  // Designer-side undo for a customer discard: the card returns to the
  // active checklist (its approval state was never touched).
  async function handleRestore(member: MemberProof) {
    if (busyAction) return
    setBusyAction(`restore-${member.id}`)
    setActionError(null)
    const { error } = await supabase
      .from('proofs')
      .update({ set_discarded_at: null })
      .eq('id', member.id)
    if (error) setActionError(`Couldn’t restore the card: ${error.message}`)
    else await load()
    setBusyAction(null)
  }

  async function handleDeleteSet() {
    if (!set || busyAction) return
    setBusyAction('delete')
    setActionError(null)
    const { error } = await supabase.from('proof_sets').delete().eq('id', set.id)
    if (error) {
      setActionError(`Couldn’t delete the bundle: ${error.message}`)
      setBusyAction(null)
      setDeleteOpen(false)
      return
    }
    void logAudit({
      action: 'proof_set.deleted',
      targetType: 'proof_set',
      targetId: set.id,
      targetLabel: customerLabel,
      metadata: { released_cards: members.length },
    })
    // Members are released back to standalone proofs (FK ON DELETE SET NULL).
    navigate(members[0] ? `/proofs/${members[0].id}` : '/')
  }

  function copyReviewLink() {
    void navigator.clipboard?.writeText(reviewUrl).then(
      () => {
        setLinkCopied(true)
        setTimeout(() => setLinkCopied(false), 2000)
      },
      () => {},
    )
  }

  if (loading) {
    return (
      <DesignerChrome active="proofs">
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      </DesignerChrome>
    )
  }

  if (loadError || !set) {
    return (
      <DesignerChrome active="proofs">
        <div className="mx-auto max-w-2xl px-4 py-16">
          <div className="rounded-2xl bg-surface p-8 text-center shadow-sm ring-1 ring-line">
            <h1 className="text-lg font-semibold text-ink">Bundle not found</h1>
            <p className="mt-2 text-sm text-ink-soft">{loadError}</p>
            <Link to="/" className="mt-4 inline-block text-sm font-semibold text-ink underline underline-offset-4">
              Back to the dashboard
            </Link>
          </div>
        </div>
      </DesignerChrome>
    )
  }

  return (
    <DesignerChrome active="proofs">
      <div className="min-h-dvh bg-canvas">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          {/* Breadcrumb */}
          <nav className="mb-4 text-xs text-ink-mute">
            <Link to="/" className="hover:text-ink">Proofs</Link>
            <span className="mx-1.5">/</span>
            <span className="text-ink-soft">{customerLabel}</span>
            <span className="mx-1.5">/</span>
            <span className="text-ink-soft">Bundle</span>
          </nav>

          {/* ── Shared-context header — entered once, inherited by every card ── */}
          <header className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Eyebrow>Bundle</Eyebrow>
                <h1 className="mt-2 text-2xl font-bold text-ink">{customerLabel}</h1>
                {companyName && contact && (
                  <p className="mt-0.5 text-sm text-ink-soft">{contact.full_name}</p>
                )}
                <p className="mt-3 text-sm text-ink-soft">
                  {isSent ? (
                    <>
                      Sent to the customer on {new Date(set.sent_at!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {set.last_opened_at && (
                        <> · last opened {new Date(set.last_opened_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>
                      )}
                      {' '}· {approvedCount} of {activeMembers.length} approved
                      {unannounced.length > 0 && (
                        <>
                          {' '}·{' '}
                          <span className="font-medium text-amber-700">
                            {unannounced.length === 1 ? '1 card' : `${unannounced.length} cards`} awaiting an update send
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <>Draft — not yet sent. Add each card, then send the customer one link to review the whole bundle.</>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ButtonGhost icon={Eye} onClick={() => window.open(setReviewPath(set.id, set.token, { preview: true }), '_blank')}>
                  Preview customer view
                </ButtonGhost>
                {isSent ? (
                  <>
                    <ButtonGhost icon={linkCopied ? Check : Copy} onClick={copyReviewLink}>
                      {linkCopied ? 'Copied' : 'Copy review link'}
                    </ButtonGhost>
                    {unannounced.length > 0 && (
                      <ButtonCoral icon={Send} onClick={() => void openSendModal()} disabled={sendBlocker != null} title={sendBlocker ?? undefined}>
                        Send update to customer
                      </ButtonCoral>
                    )}
                  </>
                ) : (
                  <ButtonCoral icon={Send} onClick={() => void openSendModal()} disabled={sendBlocker != null} title={sendBlocker ?? undefined}>
                    Send bundle to customer
                  </ButtonCoral>
                )}
              </div>
            </div>

            {/* The context entered once. */}
            <dl className="mt-6 grid gap-x-8 gap-y-3 border-t border-line pt-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-mute">Customer</dt>
                <dd className="mt-0.5 font-medium text-ink">{contact?.full_name ?? '—'}</dd>
                {contact?.email && <dd className="text-xs text-ink-mute">{contact.email}</dd>}
              </div>
              <div>
                <dt className="text-xs text-ink-mute">Help Scout</dt>
                <dd className="mt-0.5">
                  {set.helpscout_conversation_url ? (
                    <a
                      href={set.helpscout_conversation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-4 hover:opacity-80"
                    >
                      Open conversation <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-ink-mute">Not linked</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-mute">Currency</dt>
                <dd className="mt-0.5 font-medium text-ink">{set.currency ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-mute">Review link</dt>
                <dd className="mt-0.5">
                  <button
                    type="button"
                    onClick={copyReviewLink}
                    className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-4 hover:opacity-80"
                  >
                    {linkCopied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    {linkCopied ? 'Copied' : 'Copy link'}
                  </button>
                </dd>
              </div>
            </dl>

            {sendBlocker && (!isSent || unannounced.length > 0) && (
              <p className="mt-4 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-soft ring-1 ring-line">
                {isSent ? 'To send the update' : 'To send'}: {sendBlocker}
              </p>
            )}
          </header>

          {actionError && (
            <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{actionError}</p>
          )}

          {/* ── The cards ─────────────────────────────────────────────────── */}
          <div className="mt-6">
            <PanelShell
              eyebrow="The bundle"
              title="Cards"
              count={members.length}
              icon={Layers}
              action={
                <div className="flex items-center gap-2">
                  <ButtonGhost size="sm" onClick={() => setAttachOpen(true)}>
                    Add existing project
                  </ButtonGhost>
                  <ButtonCoral size="sm" icon={Plus} onClick={handleAddCard} busy={busyAction === 'add'}>
                    Add a card
                  </ButtonCoral>
                </div>
              }
            >
              {members.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-mute">
                  No cards yet — add the first one to get started.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {members.map((m) => {
                    const title = m.currentVersion
                      ? (m.currentVersion.names.filter((n) => n.trim()).join(' & ') || m.currentVersion.material_display || 'Card')
                      : 'New card — no artwork yet'
                    const sub = m.currentVersion
                      ? [
                          m.currentVersion.material_display,
                          `v${m.currentVersion.version_number}`,
                          m.currentVersion.currency ?? undefined,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'Add a version to build this card'
                    const discarded = !!m.set_discarded_at
                    return (
                      <li key={m.id} className={`flex flex-wrap items-center gap-4 py-4 ${discarded ? 'opacity-70' : ''}`}>
                        <div className="h-14 w-20 shrink-0 overflow-hidden rounded-md bg-canvas ring-1 ring-line">
                          {m.thumbUrl ? (
                            <img src={m.thumbUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[9px] uppercase tracking-wide text-ink-mute">
                              {m.currentVersion ? 'No image' : 'Empty'}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link to={`/proofs/${m.id}`} className={`truncate text-sm font-semibold text-ink hover:underline ${discarded ? 'line-through' : ''}`}>
                              {title}
                            </Link>
                            <ProofStatusPill status={m.status} />
                          </div>
                          <p className="mt-0.5 truncate text-xs text-ink-mute">{sub}</p>
                          {discarded && (
                            <p className="mt-1 text-xs text-amber-700">
                              Customer set this card aside
                              {m.discardReason ? <> — {m.discardReason}</> : null}
                              {m.discardNote ? <> · “{m.discardNote}”</> : null}
                            </p>
                          )}
                          {isSent && !discarded && !m.currentVersion?.last_reply_sent_at && (
                            <p className="mt-1 text-xs text-amber-700">
                              Added after the bundle was sent — the customer hasn’t been told yet.
                              {m.currentVersion ? ' Send an update above.' : ' Build the card, then send an update.'}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!m.currentVersion && !discarded && (
                            <ButtonCoral size="sm" onClick={() => navigate(`/proofs/${m.id}/versions/new`)}>
                              Continue building
                            </ButtonCoral>
                          )}
                          <ButtonGhost size="sm" onClick={() => navigate(`/proofs/${m.id}`)}>
                            Open
                          </ButtonGhost>
                          {discarded && (
                            <ButtonGhost size="sm" onClick={() => handleRestore(m)} busy={busyAction === `restore-${m.id}`}>
                              Restore
                            </ButtonGhost>
                          )}
                          {!isSent && (
                            <ButtonGhost size="sm" onClick={() => setRemoveTarget(m)}>
                              Remove
                            </ButtonGhost>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {isSent && (
                <p className="mt-4 border-t border-line pt-3 text-xs text-ink-mute">
                  This bundle has been sent. You can still add cards — the customer keeps the same link,
                  and each addition needs an update sent from here so they know to look. Cards can’t be
                  removed once sent: the customer can set one aside on the review page, or you can abandon
                  its project. Revisions carry on as normal on each card’s own page.
                </p>
              )}
            </PanelShell>
          </div>

          {/* ── Danger zone (draft sets only) ─────────────────────────────── */}
          {!isSent && (
            <div className="mt-10 border-t border-line pt-5">
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className="text-xs text-ink-mute underline underline-offset-4 hover:text-rose-700"
              >
                Delete this bundle
              </button>
              <span className="ml-2 text-xs text-ink-mute">
                The cards themselves aren’t deleted — they go back to being standalone projects.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Bring in an existing project ───────────────────────────────────── */}
      {attachOpen && set && (
        <Modal label="Bring in an existing project" onClose={() => !attachBusy && setAttachOpen(false)}>
          <h2 className="text-lg font-semibold text-ink">Bring in an existing project</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Adds one of {customerLabel}’s other standalone projects to this bundle as another card. It
            keeps its own artwork, versions and approval state — the bundle just reviews them together.
          </p>
          <div className="mt-4">
            <ExistingProjectPicker
              contactId={set.contact_id}
              attachBusy={attachBusy}
              onAttach={(id) => void handleAttachExisting(id)}
              onBack={() => setAttachOpen(false)}
              backLabel="Cancel"
            />
          </div>
        </Modal>
      )}

      {/* ── Send modal ─────────────────────────────────────────────────────── */}
      {sendOpen && (
        <Modal label={set?.sent_at ? 'Send update to customer' : 'Send bundle to customer'} onClose={() => !sendBusy && setSendOpen(false)}>
          <h2 className="text-lg font-semibold text-ink">
            {set?.sent_at ? 'Send update to customer' : 'Send bundle to customer'}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {set?.sent_at
              ? `Tells the customer ${unannounced.length === 1 ? 'a card has' : `${unannounced.length} cards have`} been added to their review page — same link as before.`
              : `Posts one review link on the Help Scout conversation, covering all ${activeMembers.length === 1 ? 'the card' : `${activeMembers.length} cards`}. Cards added later need an update sent from here.`}
          </p>
          <textarea
            value={sendBody}
            onChange={(e) => setSendBody(e.target.value)}
            rows={9}
            className="mt-4 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink/40 focus:outline-none"
          />
          {sendError && <p className="mt-2 text-sm text-rose-700">{sendError}</p>}
          <div className="mt-4 flex items-center justify-end gap-2">
            <ButtonGhost onClick={() => setSendOpen(false)} disabled={sendBusy}>
              Cancel
            </ButtonGhost>
            <ButtonCoral icon={Send} onClick={handleSend} busy={sendBusy}>
              {set?.sent_at ? 'Send update' : 'Send review link'}
            </ButtonCoral>
          </div>
        </Modal>
      )}

      {/* ── Remove-card confirm ────────────────────────────────────────────── */}
      {removeTarget && (
        <Modal label="Remove this card from the bundle" onClose={() => setRemoveTarget(null)}>
          <h2 className="text-lg font-semibold text-ink">Remove this card from the bundle?</h2>
          <p className="mt-2 text-sm text-ink-soft">
            The card isn’t deleted — it goes back to being a standalone project with its own page and
            customer link. You can’t re-add it to this bundle once removed (you’d start a fresh bundle).
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <ButtonGhost onClick={() => setRemoveTarget(null)}>Cancel</ButtonGhost>
            <ButtonCoral onClick={() => handleRemove(removeTarget)} busy={busyAction === `remove-${removeTarget.id}`}>
              Remove card
            </ButtonCoral>
          </div>
        </Modal>
      )}

      {/* ── Delete-set confirm ─────────────────────────────────────────────── */}
      {deleteOpen && (
        <Modal label="Delete this bundle" onClose={() => setDeleteOpen(false)}>
          <h2 className="text-lg font-semibold text-ink">Delete this bundle?</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Only the bundle container is deleted — every card in it survives as a standalone project. The
            customer review link stops working.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <ButtonGhost onClick={() => setDeleteOpen(false)}>Cancel</ButtonGhost>
            <ButtonCoral onClick={handleDeleteSet} busy={busyAction === 'delete'}>
              Delete set
            </ButtonCoral>
          </div>
        </Modal>
      )}
    </DesignerChrome>
  )
}

// Thin wrapper over the shared Modal primitive (Esc, focus trap, scroll
// lock) with this page's panel chrome baked in.
function Modal({
  children,
  onClose,
  label,
}: {
  children: React.ReactNode
  onClose: () => void
  label: string
}) {
  return (
    <BaseModal
      open
      onClose={onClose}
      ariaLabel={label}
      panelClassName="w-full max-w-lg rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-line"
    >
      {children}
    </BaseModal>
  )
}
