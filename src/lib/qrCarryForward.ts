// QR carry-forward helpers for the new-version form.
//
// Two pure functions extracted from NewVersionPage so the page's
// render path and save path agree on the same logic, and so the
// rules can be unit-tested without spinning up a React tree.
//
// computeQrArtworkChangedSlots — given the v1 carry context and the
// current form state, returns the set of slot keys whose printed
// surface has been modified between v1 and v2. Drives the QR
// section's auto-unkeep + amber re-verify notice and the save-time
// "drop unkept QRs" filter.
//
// resolveQrEffectiveKeep — resolves the per-entry effective keep
// state from the designer's explicit qrKeepOverrides + the
// artworkChangedSlots set. Designer override wins; otherwise the
// auto-rule defaults to keep=false iff the slot is in the set.
//
// Both are pure functions of their inputs. No React state, no
// supabase client, no DOM. Tests live in qrCarryForward.test.ts.

// Explicit .ts extension so the test file can run under
// `node --experimental-strip-types` without falling through Vite's
// resolver. Vite's production build resolves the extension form
// without issue, mirroring the qrCodes.ts pattern used by the
// matching unit-test file.
import { SHARED_APPROVAL_KEY } from './types.ts'

// Local copies of the shapes the page passes in. Kept here (rather
// than imported from the page) so this module stays a pure lib that
// pages can import without forming a circular dependency.

export interface QrCarryV1Image {
  v1RowId: string
  associated_name: string | null
  side: 'front' | 'back' | null
}

export interface QrCarryFreshEntry {
  associated_name: string | null
}

export interface QrCarryContext {
  /** Names roster on v1, used to detect "name dropped on v2". */
  names: string[]
  images: QrCarryV1Image[]
}

/**
 * Compute the set of slot keys whose printed surface has been
 * modified between v1 and v2. A slot key is a recipient name from
 * v1Carry.names or SHARED_APPROVAL_KEY for the assoc_name=null
 * shared sentinel.
 *
 * A slot is considered modified when ANY of the following applies:
 *   * one of its v1 images has been unkept (keep toggle off)
 *   * one of its v1 images has a queued replacement
 *   * the slot's recipient name has been removed from v2's roster
 *   * a fresh image entry has been added to the slot in v2
 *
 * Shape flips (sidedness, shared, cardType) cascade through the
 * keep/replacement state via cleanupReplacementsFor at the page
 * level, so they show up here via the first two predicates above
 * without needing their own dedicated check.
 *
 * Pure function — same inputs, same outputs, no side effects.
 */
export function computeQrArtworkChangedSlots(
  v1Carry: QrCarryContext | null,
  keepByV1RowId: Record<string, boolean>,
  replacementByV1RowId: Record<string, unknown>,
  freshEntriesByOption: Record<string, QrCarryFreshEntry[]>,
  v2Names: string[],
): Set<string> {
  const set = new Set<string>()
  if (!v1Carry) return set
  const v2NameSet = new Set(v2Names)

  // v1 images the designer has unkept or queued a replacement for.
  // Either signal independently invalidates the slot's carry.
  for (const img of v1Carry.images) {
    const slotKey = img.associated_name ?? SHARED_APPROVAL_KEY
    const isKept = keepByV1RowId[img.v1RowId] ?? true
    const hasReplacement = !!replacementByV1RowId[img.v1RowId]
    if (!isKept || hasReplacement) set.add(slotKey)
  }

  // Names that existed on v1 but are no longer in v2's roster.
  // Their slot has effectively been removed.
  for (const v1Name of v1Carry.names) {
    if (!v2NameSet.has(v1Name)) set.add(v1Name)
  }

  // Fresh image entries added on v2 — any new artwork on a slot
  // means that slot's appearance has changed even if every v1
  // image was kept.
  for (const list of Object.values(freshEntriesByOption)) {
    for (const entry of list) {
      const slotKey = entry.associated_name ?? SHARED_APPROVAL_KEY
      set.add(slotKey)
    }
  }

  return set
}

/**
 * Decide whether the printed surface a QR appears on has been
 * modified between v1 and v2 — i.e. whether the QR should be
 * surfaced with the amber re-verify notice and an auto-unkeep
 * default.
 *
 * A QR's "surface" depends on its associatedName:
 *
 *   * A SHARED QR (associatedName == null) appears on every printed
 *     card. Any artwork change anywhere on the proof modifies a
 *     surface this QR sits on, so any non-empty artworkChangedSlots
 *     set flags it.
 *
 *   * A NAMED QR (associatedName === some recipient) appears on
 *     that recipient's card only. That card carries both the
 *     recipient's own artwork AND the shared artwork printed across
 *     every card, so the QR is flagged when either the named slot
 *     OR the shared sentinel is in the set.
 *
 * Mirrors the slot-membership rule the byte-identity check uses on
 * the customer side (slotQrSet, migration 000169) — a named slot's
 * QR multiset collects own-name QRs plus shared QRs, so the
 * designer-side prompt and the customer's re-confirmation operate
 * on the same surface model. Without this expansion, a shared QR
 * (or a null-assoc QR on a single-recipient proof, where the
 * recipient dropdown is suppressed and assoc stays at null) would
 * silently ride through a named-slot artwork change without
 * prompting the designer.
 */
export function isQrSlotFlagged(
  associatedName: string | null,
  artworkChangedSlots: Set<string>,
): boolean {
  if (associatedName === null) {
    // Shared QR — appears on every printed card. Any change to any
    // surface this QR sits on triggers the auto-unkeep prompt.
    return artworkChangedSlots.size > 0
  }
  return (
    artworkChangedSlots.has(associatedName) ||
    artworkChangedSlots.has(SHARED_APPROVAL_KEY)
  )
}

/**
 * Resolve the effective Keep state for an existing QR entry. The
 * designer's explicit override (qrKeepOverrides[entryId], if set)
 * always wins. Otherwise apply the auto-rule: keep=true unless the
 * QR's surface has been modified (per isQrSlotFlagged), in which
 * case keep=false to force a deliberate re-verify.
 *
 * Callers that pass a `new`-source entry should skip this — fresh
 * entries are always kept (the designer added them deliberately on
 * this version; Remove is their disposal route).
 */
export function resolveQrEffectiveKeep(
  entryId: string,
  associatedName: string | null,
  qrKeepOverrides: Record<string, boolean>,
  artworkChangedSlots: Set<string>,
): boolean {
  const override = qrKeepOverrides[entryId]
  if (override !== undefined) return override
  return !isQrSlotFlagged(associatedName, artworkChangedSlots)
}
