// Proof-set helpers — bundle orders Slice 3 (docs/bundle-orders-spec.md §14).
//
// A proof SET is the PROOFING layer: a thin container over N member proofs
// (one per card, typically one per material) so the customer gets ONE link
// to review and approve the whole collection, and the designer enters the
// shared context (customer, Help Scout conversation, currency) once.
// Completely separate from order_groups (Slice 2, the payment layer) — a
// set ends at approval and carries no pricing or order state.
//
// Membership is a single nullable pointer, proofs.proof_set_id. It LOCKS
// once the set is sent to the customer (proof_sets.sent_at) — these helpers
// enforce that app-side, mirroring how order-group eligibility lives in the
// order-group edge function.

import { supabase } from './supabase'
import { logAudit } from './audit'

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

// The customer review link. Mirrors the /order/group/:id?token=… posture:
// the id routes, the bearer token gates the RPC read.
export function setReviewPath(setId: string, token: string, opts?: { preview?: boolean }): string {
  return `/set/${setId}?token=${encodeURIComponent(token)}${opts?.preview ? '&preview=1' : ''}`
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
    if (exErr) throw new Error(`Couldn't load the existing set: ${exErr.message}`)
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
  if (setErr) throw new Error(`Couldn't create the set: ${setErr.message}`)

  const contactName = (proof as { contacts?: { full_name?: string } | null }).contacts?.full_name ?? ''

  if (attachSource) {
    const { error: linkErr } = await supabase
      .from('proofs')
      .update({ proof_set_id: set.id })
      .eq('id', proofId)
    if (linkErr) throw new Error(`Created the set but couldn't attach this proof: ${linkErr.message}`)
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
  if (setErr) throw new Error(`Couldn't load the set: ${setErr.message}`)
  if (set.sent_at) {
    throw new Error('This set has been sent to the customer, so its cards are locked. A new card starts a fresh set.')
  }

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
