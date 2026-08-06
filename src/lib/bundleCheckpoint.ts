// The post-save BUNDLE CHECKPOINT — routing, not new machinery.
//
// The problem (Experience Auto Group, Aug 2026): a revision round on a
// 3-card bundle means saving a new version on each card, and each save ends
// at the MessageSendPanel with "Send reply" as the big primary button and
// the bundle review link pre-filled. The natural reflex therefore (a) emails
// the customer after the FIRST card, inviting them to a half-updated bundle,
// and (b) does it three times, all with the same link. The correct ending —
// one email once every card is revised — already exists on the bundle
// workspace ("Send update to customer" announces every card whose current
// version lacks send evidence, and stamps them all), but nothing routed the
// designer there; the right action was the demoted Skip button.
//
// The checkpoint replaces the send panel for bundle members mid-round: a
// per-card checklist of where the bundle stands, "Back to the bundle" as the
// primary action while sibling cards are still outstanding, flipping to the
// bundle send itself once every card carries unannounced changes. The
// per-card send stays available behind an explicit link, with a caution —
// demoted, never removed.
//
// This module is the PURE half (no supabase import, so `tsx` can run the
// tests): classification, recommendation and the copy rules. The data fetch
// lives in proofSets.ts (fetchBundleCheckpointMembers); the UI in
// components/BundleCheckpoint.tsx.
//
// Run tests: pnpm test:bundle-checkpoint

// ── Inputs ───────────────────────────────────────────────────────────────────
//
// Shape mirrors what fetchBundleCheckpointMembers returns — one row per
// member proof, with its CURRENT version (null on a shell that hasn't been
// built yet). last_reply_sent_at is the send-evidence stamp the workspace's
// announce logic keys on: null = the customer hasn't been told about this
// version, whether it's a brand-new card or a revision of one they've seen.

export interface CheckpointVersion {
  id: string
  version_number: number
  material_display: string | null
  names: string[]
  last_reply_sent_at: string | null
}

export interface CheckpointMember {
  proof_id: string
  status: string
  set_discarded_at: string | null
  current_version: CheckpointVersion | null
}

// ── Model ────────────────────────────────────────────────────────────────────

export type CheckpointCardState =
  // The card whose save opened the checkpoint. Always unannounced — the
  // builder returns null otherwise (see below).
  | 'saved_now'
  // Sibling with saved changes the customer hasn't been told about yet.
  | 'awaiting_send'
  // Sibling whose current version already carries send evidence — on a sent
  // bundle that means the customer has its latest version, i.e. this is the
  // card still waiting for its revision (or one that doesn't need any; the
  // checkpoint can't tell, and deliberately doesn't guess).
  | 'with_customer'
  // Sibling shell with no version at all.
  | 'no_artwork'

export interface CheckpointRow {
  proofId: string
  label: string
  sub: string | null
  state: CheckpointCardState
  stateLabel: string
  isSavedCard: boolean
}

export interface BundleCheckpointModel {
  setSent: boolean
  rows: CheckpointRow[]
  activeCount: number
  // Cards ONE bundle send would not cover right now: shells with no artwork,
  // plus (sent bundles only) cards whose current version the customer
  // already holds. While this is non-zero the round looks unfinished and the
  // primary action stays "Back to the bundle".
  outstandingCount: number
  // Every active card carries changes one send can announce — the moment the
  // single email is right, so the primary action becomes the bundle send.
  readyForOneSend: boolean
}

// ── Builder ──────────────────────────────────────────────────────────────────
//
// Returns null when the checkpoint shouldn't show and the plain send panel
// is the right flow:
//   * the saved card isn't an active member (removed / discarded / abandoned
//     mid-save — resolveCustomerReviewLink already returns a card link for
//     those, this is the belt to its braces);
//   * the saved version isn't the proof's CURRENT version (an edit of an
//     older version — the bundle page shows current, so the bundle-round
//     story doesn't apply);
//   * the saved version already carries send evidence (an edit of an
//     announced version — the workspace's announce logic would skip it, so
//     the per-card panel is the honest way to tell the customer);
//   * fewer than two active members (a bundle of one has no round to
//     coordinate).

export function buildBundleCheckpoint(args: {
  members: CheckpointMember[]
  savedProofId: string
  savedVersionId: string
  setSentAt: string | null
}): BundleCheckpointModel | null {
  const { members, savedProofId, savedVersionId, setSentAt } = args
  const setSent = setSentAt != null

  const active = members.filter((m) => !m.set_discarded_at && m.status !== 'abandoned')
  if (active.length < 2) return null

  const saved = active.find((m) => m.proof_id === savedProofId)
  if (!saved?.current_version) return null
  if (saved.current_version.id !== savedVersionId) return null
  if (saved.current_version.last_reply_sent_at != null) return null

  const rows: CheckpointRow[] = active.map((m) => {
    const isSavedCard = m.proof_id === savedProofId
    const state: CheckpointCardState = isSavedCard
      ? 'saved_now'
      : !m.current_version
        ? 'no_artwork'
        : m.current_version.last_reply_sent_at == null
          ? 'awaiting_send'
          : 'with_customer'
    return {
      proofId: m.proof_id,
      label: cardLabel(m.current_version),
      sub: cardSub(m.current_version),
      state,
      stateLabel: stateLabel(state, setSent, m.current_version),
      isSavedCard,
    }
  })

  // On an UNSENT bundle an announced sibling isn't outstanding: the initial
  // bundle send covers every active card regardless (the workspace stamps
  // them all), so only artwork-less shells hold the send back — matching the
  // workspace's own sendBlocker. On a SENT bundle the update send only
  // announces unannounced cards, so an announced sibling is exactly the card
  // still waiting for its revision.
  const outstandingCount = rows.filter(
    (r) => r.state === 'no_artwork' || (setSent && r.state === 'with_customer'),
  ).length

  return {
    setSent,
    rows,
    activeCount: active.length,
    outstandingCount,
    readyForOneSend: outstandingCount === 0,
  }
}

// ── Labels ───────────────────────────────────────────────────────────────────
//
// Mirror the workspace's card-title logic so a card reads the same in both
// places: recipient names when there are any, else the material.

function cardLabel(v: CheckpointVersion | null): string {
  if (!v) return 'New card'
  const names = v.names.filter((n) => n.trim()).join(' & ')
  return names || v.material_display || 'Card'
}

function cardSub(v: CheckpointVersion | null): string | null {
  if (!v) return 'no artwork yet'
  const names = v.names.some((n) => n.trim())
  return [names ? v.material_display : null, `v${v.version_number}`].filter(Boolean).join(' · ') || null
}

export function stateLabel(
  state: CheckpointCardState,
  setSent: boolean,
  v: CheckpointVersion | null,
): string {
  switch (state) {
    case 'saved_now':
      // "Updated" for a revision, "Saved" for a first version — a brand-new
      // card added to the bundle hasn't been "updated" from anything.
      return (v?.version_number ?? 1) > 1 ? 'Updated just now' : 'Saved just now'
    case 'awaiting_send':
      return setSent ? 'Not announced yet' : 'Ready to send'
    case 'with_customer':
      return setSent ? 'Customer has the latest version' : 'Sent separately earlier'
    case 'no_artwork':
      return 'No artwork yet'
  }
}

// ── Copy rules ───────────────────────────────────────────────────────────────
//
// Kept here rather than in the component so the tests pin the decisions that
// matter: mid-round guidance must steer to the bundle, the ready state must
// name the single email, and the per-card option must always carry a caution
// (it's demoted for a reason — say what sending now actually does).

export function checkpointGuidance(model: BundleCheckpointModel): string {
  if (model.setSent) {
    return model.readyForOneSend
      ? `Every card now has changes the customer hasn’t seen. Send one update from the bundle page and they get a single email covering all ${model.activeCount} cards.`
      : 'If the other cards are getting the same change, update them first — then send one update from the bundle page, so the customer gets a single email covering everything instead of one per card.'
  }
  return model.readyForOneSend
    ? 'Every card is built. Send the customer one link to review the whole bundle.'
    : 'This bundle hasn’t been sent yet. Finish the remaining cards, then send the customer one link to review the whole bundle.'
}

export function sendJustThisCardCaution(model: BundleCheckpointModel): string {
  if (!model.setSent) {
    return 'This emails the bundle link now, introduced with a message about just this card — the customer could open it and see the cards that aren’t ready.'
  }
  return model.readyForOneSend
    ? 'This announces only this card — the other updated cards would still be waiting for a bundle update.'
    : 'This emails the customer straight away — if they open their review page now, the other cards will show as they stand today.'
}

export function primaryActionLabel(model: BundleCheckpointModel): string {
  if (!model.readyForOneSend) return 'Back to the bundle'
  return model.setSent ? 'Send one update for the whole bundle' : 'Send the bundle to the customer'
}
