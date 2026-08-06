// Proof-set helpers — bundle orders Slice 3 (docs/bundle-orders-spec.md §14).
//
// A proof SET is the PROOFING layer: a thin container over N member proofs
// (one per card, typically one per material) so the customer gets ONE link
// to review and approve the whole collection, and the designer enters the
// shared context (customer, Help Scout conversation, currency) once.
// Completely separate from order_groups (Slice 2, the payment layer) — a
// set ends at approval and carries no pricing or order state.
//
// Membership is a single nullable pointer, proofs.proof_set_id. sent_at
// records the FIRST send of the review link. Cards can still be added
// afterwards (10 Jul decision): the customer keeps the one link, and the
// workspace's "Send update" step announces the new card — a card counts as
// announced once its current version carries last_reply_sent_at. Removal
// stays pre-send only; after sending, a dropped card is handled by the
// customer's set-aside or a designer abandon.

import { supabase } from './supabase'
import { logAudit } from './audit'
import { customerProofPath } from './customerProofUrl'
import type { CheckpointMember, CheckpointVersion } from './bundleCheckpoint'

export type SetCurrency = 'GBP' | 'EUR' | 'USD'

export interface ProofSetRow {
  id: string
  contact_id: string
  helpscout_conversation_id: string | null
  helpscout_conversation_url: string | null
  currency: SetCurrency | null
  token: string
  sent_at: string | null
  last_opened_at: string | null
  created_by: string | null
  created_at: string
}

// The customer review link (UI vocabulary: bundle; code/DB keep proof_sets).
// Mirrors the /order/group/:id?token=… posture: the id routes, the bearer
// token gates the RPC read.
export function setReviewPath(setId: string, token: string, opts?: { preview?: boolean }): string {
  return `/bundle/${setId}?token=${encodeURIComponent(token)}${opts?.preview ? '&preview=1' : ''}`
}

// Which link the CUSTOMER receives for a proof. The everyday send surfaces
// (the post-save reply, the detail-page resend, Copy customer URL, manual
// reminders) used to hand out the card's /p/:id link even when the proof had
// a bundle front door — so the customer ended up on one card's sub-page
// instead of the overview. This is the single answer they all share now.
//
// Two policies, matching the auto-sender (send-nudges):
//   * presentation (default) — the send IS the introduction, so an active
//     bundle member gets the bundle review link even if the bundle has never
//     been sent; the caller stamps sent_at on a successful send via
//     markSetReviewLinkSent below.
//   * chase — a reminder must re-present a link the customer already holds,
//     so the bundle link is used only when the bundle was SENT; members of
//     an unsent bundle (card sent standalone first, attached later) keep the
//     /p/ link — that's the only link the customer has.
//
// A set-aside or abandoned card always keeps its /p/ link: the front door
// lists those as "Set aside" with no way in, so pointing the customer there
// would dead-end. Any lookup failure falls back to the card link — exactly
// the pre-bundle behaviour, never a blocked send.
export type CustomerReviewLink =
  | { kind: 'card'; url: string }
  | { kind: 'bundle'; url: string; setId: string; setSentAt: string | null }

export async function resolveCustomerReviewLink(
  proofId: string,
  opts?: { chase?: boolean },
): Promise<CustomerReviewLink> {
  const cardLink: CustomerReviewLink = {
    kind: 'card',
    url: `${window.location.origin}${customerProofPath(proofId)}`,
  }
  try {
    const { data: proof } = await supabase
      .from('proofs')
      .select('proof_set_id, set_discarded_at, status')
      .eq('id', proofId)
      .maybeSingle()
    if (!proof?.proof_set_id || proof.set_discarded_at || proof.status === 'abandoned') {
      return cardLink
    }
    const { data: set } = await supabase
      .from('proof_sets')
      .select('id, token, sent_at')
      .eq('id', proof.proof_set_id)
      .maybeSingle()
    if (!set?.token) return cardLink
    if (opts?.chase && !set.sent_at) return cardLink
    return {
      kind: 'bundle',
      url: `${window.location.origin}${setReviewPath(set.id, set.token)}`,
      setId: set.id,
      setSentAt: set.sent_at,
    }
  } catch (err) {
    console.warn('[proofSets] bundle link lookup failed, using /p/ link', err)
    return cardLink
  }
}

// First-send bookkeeping for sends that bypass the workspace's own Send
// button: when a version reply carries the bundle review link, the bundle
// has gone out just as surely as via the workspace, so stamp sent_at (the
// workspace flips to "Sent to the customer", and membership rules see a
// sent bundle). Guarded on sent_at IS NULL — a repeat send, or a race with
// the workspace, is a 0-row no-op and logs nothing.
export async function markSetReviewLinkSent(setId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('proof_sets')
    .update({ sent_at: nowIso, updated_at: nowIso })
    .eq('id', setId)
    .is('sent_at', null)
    .select('id')
  if (error) {
    console.warn('[proofSets] could not stamp bundle sent_at', error)
    return
  }
  if (!data?.length) return
  void logAudit({
    action: 'proof_set.sent',
    targetType: 'proof_set',
    targetId: setId,
    metadata: { source: 'version_reply' },
  })
}

// Member snapshot for the post-save bundle checkpoint (bundleCheckpoint.ts):
// every member proof with its current version's announce state. Null on ANY
// failure — the caller falls back to the plain send panel, exactly the
// resolveCustomerReviewLink posture: a broken lookup must never block a send.
export async function fetchBundleCheckpointMembers(setId: string): Promise<CheckpointMember[] | null> {
  try {
    const { data: proofRows, error: proofsErr } = await supabase
      .from('proofs')
      .select('id, status, set_discarded_at, created_at')
      .eq('proof_set_id', setId)
      .order('created_at', { ascending: true })
    if (proofsErr) return null
    const rows = proofRows ?? []
    if (rows.length === 0) return []

    const { data: versions, error: vErr } = await supabase
      .from('proof_versions')
      .select('id, proof_id, version_number, material_display, names, last_reply_sent_at')
      .in('proof_id', rows.map((p) => p.id))
      .eq('is_current', true)
    if (vErr) return null
    const byProof = new Map(
      ((versions ?? []) as Array<CheckpointVersion & { proof_id: string }>).map((v) => [v.proof_id, v]),
    )
    return rows.map((p) => ({
      proof_id: p.id as string,
      status: p.status as string,
      set_discarded_at: p.set_discarded_at as string | null,
      current_version: byProof.get(p.id) ?? null,
    }))
  } catch (err) {
    console.warn('[proofSets] bundle checkpoint lookup failed, falling back to the send panel', err)
    return null
  }
}

// 48 hex chars from the browser CSPRNG — same bearer-token posture as
// orders.token / order_groups.token (those are minted by edge functions;
// sets are created by the signed-in designer, so the token is minted here).
export function generateSetToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Create a set seeded from an existing proof's customer context, and attach
// that proof as the set's first card. Used by both designer entry points:
//
//   * Entry A — the proof-type wizard's "different materials" fork on the
//     new-version form ("build the cards one at a time").
//   * Entry B — "Add another material" on an existing proof's detail page.
//
// If the proof already belongs to a set, returns that set untouched.
// `attachSource: false` creates a sibling set from the same context WITHOUT
// moving the proof — used when the proof's own set has already been sent
// (membership locked), so a later card starts a fresh set with a fresh link.
export async function createSetFromProof(
  proofId: string,
  userId: string,
  opts?: { currency?: SetCurrency | null; attachSource?: boolean },
): Promise<{ setId: string; token: string; alreadyExisted: boolean }> {
  const attachSource = opts?.attachSource ?? true

  const { data: proof, error: proofErr } = await supabase
    .from('proofs')
    .select('id, contact_id, proof_set_id, helpscout_conversation_id, helpscout_conversation_url, contacts(full_name)')
    .eq('id', proofId)
    .single()
  if (proofErr) throw new Error(`Couldn't load this proof: ${proofErr.message}`)

  if (attachSource && proof.proof_set_id) {
    const { data: existing, error: exErr } = await supabase
      .from('proof_sets')
      .select('id, token')
      .eq('id', proof.proof_set_id)
      .single()
    if (exErr) throw new Error(`Couldn't load the existing bundle: ${exErr.message}`)
    return { setId: existing.id, token: existing.token, alreadyExisted: true }
  }

  // Currency context: the caller's live pick wins (Entry A passes the version
  // form's currency); otherwise inherit from the proof's current version.
  let currency: SetCurrency | null = opts?.currency ?? null
  if (currency === undefined || currency === null) {
    const { data: cv } = await supabase
      .from('proof_versions')
      .select('currency')
      .eq('proof_id', proofId)
      .eq('is_current', true)
      .maybeSingle()
    const c = cv?.currency as string | null | undefined
    currency = c === 'GBP' || c === 'EUR' || c === 'USD' ? c : null
  }

  const token = generateSetToken()
  const { data: set, error: setErr } = await supabase
    .from('proof_sets')
    .insert({
      contact_id: proof.contact_id,
      helpscout_conversation_id: proof.helpscout_conversation_id,
      helpscout_conversation_url: proof.helpscout_conversation_url,
      currency,
      token,
      created_by: userId,
    })
    .select('id, token')
    .single()
  if (setErr) throw new Error(`Couldn't create the bundle: ${setErr.message}`)

  const contactName = (proof as { contacts?: { full_name?: string } | null }).contacts?.full_name ?? ''

  if (attachSource) {
    const { error: linkErr } = await supabase
      .from('proofs')
      .update({ proof_set_id: set.id })
      .eq('id', proofId)
    if (linkErr) throw new Error(`Created the bundle but couldn't attach this proof: ${linkErr.message}`)
  }

  void logAudit({
    action: 'proof_set.created',
    targetType: 'proof_set',
    targetId: set.id,
    targetLabel: contactName,
    metadata: { from_proof_id: proofId, attached_source: attachSource, currency },
  })

  return { setId: set.id, token: set.token, alreadyExisted: false }
}

// A standalone project of the same customer that could be brought into a
// set, with enough of its current version to label it in a picker.
export interface AttachableProof {
  id: string
  status: string
  created_at: string
  version_number: number | null
  material_display: string | null
  names: string[]
}

// The customer's other standalone projects — candidates for "bring in an
// existing project". Same contact, not already in a set, not abandoned.
export async function listAttachableProofs(
  contactId: string,
  excludeProofId?: string,
): Promise<AttachableProof[]> {
  let query = supabase
    .from('proofs')
    .select('id, status, created_at')
    .eq('contact_id', contactId)
    .is('proof_set_id', null)
    .neq('status', 'abandoned')
    .order('created_at', { ascending: false })
  if (excludeProofId) query = query.neq('id', excludeProofId)
  const { data: proofs, error } = await query
  if (error) throw new Error(`Couldn't load this customer's other projects: ${error.message}`)
  const rows = proofs ?? []
  if (rows.length === 0) return []

  const { data: versions } = await supabase
    .from('proof_versions')
    .select('proof_id, version_number, material_display, names')
    .in('proof_id', rows.map((p) => p.id))
    .eq('is_current', true)
  const byProof = new Map(
    ((versions ?? []) as Array<{ proof_id: string; version_number: number; material_display: string; names: string[] }>).map(
      (v) => [v.proof_id, v],
    ),
  )
  return rows.map((p) => {
    const v = byProof.get(p.id)
    return {
      id: p.id,
      status: p.status as string,
      created_at: p.created_at as string,
      version_number: v?.version_number ?? null,
      material_display: v?.material_display ?? null,
      names: v?.names ?? [],
    }
  })
}

// Bring an EXISTING standalone project into an unsent set as another card.
// The complement of addCardToSet for work that's already been started —
// "combine two separate projects into one review link". The proof keeps its
// own versions, approvals and Help Scout link; only its set membership
// changes (and the send anchors on the set's conversation).
export async function attachProofToSet(setId: string, proofId: string): Promise<void> {
  const { data: set, error: setErr } = await supabase
    .from('proof_sets')
    .select('id, contact_id, sent_at')
    .eq('id', setId)
    .single()
  if (setErr) throw new Error(`Couldn't load the bundle: ${setErr.message}`)
  // Attaching to a SENT bundle is allowed (10 Jul) — the workspace's
  // "Send update" step announces the new card on the same link.

  const { data: proof, error: proofErr } = await supabase
    .from('proofs')
    .select('id, contact_id, proof_set_id, status, contacts(full_name)')
    .eq('id', proofId)
    .single()
  if (proofErr) throw new Error(`Couldn't load that project: ${proofErr.message}`)
  if (proof.proof_set_id) throw new Error('That project is already part of a bundle.')
  if (proof.status === 'abandoned') throw new Error('That project has been abandoned — reopen it first.')
  if (proof.contact_id !== set.contact_id) {
    throw new Error('That project belongs to a different contact, so it can’t join this bundle.')
  }

  const { error: linkErr } = await supabase
    .from('proofs')
    .update({ proof_set_id: setId, set_discarded_at: null })
    .eq('id', proofId)
  if (linkErr) throw new Error(`Couldn't add the project to the bundle: ${linkErr.message}`)

  void logAudit({
    action: 'proof_set.card_added',
    targetType: 'proof_set',
    targetId: setId,
    targetLabel: (proof as { contacts?: { full_name?: string } | null }).contacts?.full_name ?? '',
    metadata: { proof_id: proofId, attached_existing: true },
  })
}

// Add a fresh card (a proof shell, exactly what the new-project form
// creates) to an unsent set, inheriting the set's customer + Help Scout
// context. Returns the new proof's id — the caller sends the designer to
// /proofs/:id/versions/new to author the card as today.
export async function addCardToSet(setId: string, userId: string): Promise<{ proofId: string }> {
  const { data: set, error: setErr } = await supabase
    .from('proof_sets')
    .select('id, contact_id, helpscout_conversation_id, helpscout_conversation_url, sent_at, contacts(full_name)')
    .eq('id', setId)
    .single()
  if (setErr) throw new Error(`Couldn't load the bundle: ${setErr.message}`)
  // Adding to an already-SENT bundle is allowed (10 Jul): the customer keeps
  // the one link, and the workspace's "Send update" step tells them about
  // the new card. A card is "announced" once its current version carries
  // last_reply_sent_at — until then the workspace shows it as pending an
  // update send.

  const { data: proof, error: proofErr } = await supabase
    .from('proofs')
    .insert({
      contact_id: set.contact_id,
      proof_set_id: set.id,
      helpscout_thread_url: set.helpscout_conversation_url,
      helpscout_conversation_id: set.helpscout_conversation_id,
      helpscout_conversation_url: set.helpscout_conversation_url,
      // The proofs CHECK requires a conversation URL or an override reason.
      // A set inherits its Help Scout link (or lack of one) from the first
      // card, whose own creation already went through the new-project form's
      // link-or-override rule.
      helpscout_override_reason: set.helpscout_conversation_url ? null : 'Added as a card in a proof set',
      created_by: userId,
    })
    .select('id')
    .single()
  if (proofErr) throw new Error(`Couldn't create the new card: ${proofErr.message}`)

  const contactName = (set as { contacts?: { full_name?: string } | null }).contacts?.full_name ?? ''
  void logAudit({
    action: 'proof.created',
    targetType: 'proof',
    targetId: proof.id,
    targetLabel: contactName,
    metadata: { contact_id: set.contact_id, proof_set_id: set.id, source: 'proof_set_add_card' },
  })
  void logAudit({
    action: 'proof_set.card_added',
    targetType: 'proof_set',
    targetId: set.id,
    targetLabel: contactName,
    metadata: { proof_id: proof.id },
  })

  return { proofId: proof.id }
}
