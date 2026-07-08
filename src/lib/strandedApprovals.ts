// Bundle-order guardrails, Slice 1 (see docs/bundle-orders-spec.md §12).
//
// Background: a "version" is meant to be a newer draft of the SAME card. If a
// designer builds one product (say steel for Bita) as v1, gets it approved,
// then REPLACES it with a genuinely different product (letterpress for Hirok)
// as v2 and gets that approved too, only the current version (v2) can ever be
// ordered. Bita's steel approval on v1 is "stranded" — approved but
// unreachable, invisible on customer revisit, impossible to order. That's the
// Novion case this slice exists to catch.
//
// This module holds the two pure checks the UI reuses so the order-time guard
// and the admin report agree by construction:
//   * findStrandedMaterialApprovals — given a proof's versions + approvals,
//     which approved cards are stranded on a non-current version in a
//     DIFFERENT material than the current one.
//   * rostersAreDisjoint — do two recipient rosters name entirely different
//     people (used by the new-version form to spot a swap-as-version-bump
//     before it happens).
//
// No schema changes: both functions read data the app already loads.

import { SHARED_APPROVAL_KEY } from './types'

// Structural inputs — kept to the few fields we need so callers can pass their
// own richer row types (ModalVersion, ProofNameApproval, or raw query rows)
// without adapters.
export interface StrandedVersion {
  id: string
  version_number: number
  material_id: string | null
  material_display: string | null
  is_current: boolean
}

export interface StrandedApprovalRow {
  proof_version_id: string
  name: string
  state: string
}

export interface StrandedCard {
  versionId: string
  versionNumber: number
  /** The stranded version's material, for naming it in the warning. */
  material: string | null
  /** Recipient labels; the shared-artwork sentinel renders as "Shared artwork". */
  names: string[]
}

/**
 * Find approved cards stranded on a non-current version whose material differs
 * from the current version's — i.e. a genuinely different product that got
 * smuggled in as a version bump and can no longer be ordered.
 *
 * Conservative by design (warn, don't cry wolf):
 *   * If the current version has no material to compare against (a
 *     per-direction-pricing selection carries a null material_id per
 *     000142/000144), we flag nothing.
 *   * A recipient still approved on the CURRENT version is orderable, so their
 *     older approval on a superseded version isn't stranded — excluded.
 *   * Same-material superseded approvals are ordinary revisions, not stranded.
 */
export function findStrandedMaterialApprovals(
  versions: StrandedVersion[],
  approvals: StrandedApprovalRow[],
): StrandedCard[] {
  const current = versions.find((v) => v.is_current)
  if (!current || !current.material_id) return []

  const versionById = new Map(versions.map((v) => [v.id, v]))

  const approvedOnCurrent = new Set(
    approvals
      .filter((a) => a.proof_version_id === current.id && a.state === 'approved')
      .map((a) => a.name),
  )

  const byVersion = new Map<string, StrandedCard>()
  for (const a of approvals) {
    if (a.state !== 'approved') continue
    if (a.proof_version_id === current.id) continue
    const v = versionById.get(a.proof_version_id)
    if (!v || !v.material_id) continue
    if (v.material_id === current.material_id) continue
    if (approvedOnCurrent.has(a.name)) continue

    const entry = byVersion.get(v.id) ?? {
      versionId: v.id,
      versionNumber: v.version_number,
      material: v.material_display || null,
      names: [],
    }
    // Note: for set_collection proofs the approval `name` is a per-version
    // layout id rather than a person; this slice targets the recipients-shape
    // Novion case, so raw ids are tolerated here rather than resolved to
    // titles (collections rarely trip the material-differs test anyway).
    const label = a.name === SHARED_APPROVAL_KEY ? 'Shared artwork' : a.name
    if (!entry.names.includes(label)) entry.names.push(label)
    byVersion.set(v.id, entry)
  }

  return [...byVersion.values()].sort((x, y) => y.versionNumber - x.versionNumber)
}

/**
 * True when two recipient rosters name entirely different people: both are
 * non-empty and share no name (compared trimmed + case-insensitively). Empty
 * on either side returns false — we can't conclude "different people", so we
 * stay quiet rather than warn on a legitimate revision.
 */
export function rostersAreDisjoint(a: string[], b: string[]): boolean {
  const norm = (xs: string[]) =>
    new Set(xs.map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0))
  const setA = norm(a)
  const setB = norm(b)
  if (setA.size === 0 || setB.size === 0) return false
  for (const x of setA) if (setB.has(x)) return false
  return true
}
