-- Migration 000169: QR-confirmation gating on per-recipient approvals.
--
-- Wrong data on a QR (typo'd phone number, wrong URL, stale email
-- address) is one of the highest-cost failure modes on a metal or
-- letterpress card — you can't fix it after print. The customer
-- page therefore gates approval on an explicit acknowledgement
-- that the QR contents are correct.
--
-- ── How the gate works ──────────────────────────────────────────────
--
-- A new column on proof_name_approvals, qr_confirmed_at, captures
-- the moment a customer ticks the "I've verified my QR code
-- contents" checkbox above the Approve button. The customer page
-- sets it the moment the box is ticked (so the customer can untick
-- and re-check without losing their place), unsets it on untick,
-- and the Approve action requires it to be set before submitting
-- — but only for slots whose coordinates have at least one QR row
-- on the current version. Versions with no QRs don't display the
-- tick at all and qr_confirmed_at stays null on those approval
-- rows; the predicate's "QRs exist" short-circuit means slot
-- completeness collapses back to the pre-QR rule for those.
--
-- ── Slot coordinates ────────────────────────────────────────────────
--
-- Named slot (name = some recipient): the slot's QRs are
-- proof_version_images rows on the current version where
-- is_qr_code = true AND (associated_name = <slot name> OR
-- associated_name IS NULL). The IS NULL branch means a shared
-- QR (one that applies to every printed copy) is verified by
-- every named recipient — each recipient confirms anything
-- visible on their version.
--
-- __shared__ slot (only present when names[] is empty — the
-- all-shared one-off path from 000128): every QR on the version
-- counts as the slot's QRs, regardless of associated_name.
--
-- Variant-round versions bail at the top of
-- maybe_finalize_proof_status (000141 guard), so the
-- QR-confirmation rule never applies to them. Variants are a
-- selection workflow, not an approval one, and any QRs in a
-- variant round will be rendered for visibility on the customer
-- page without a gating tick.
--
-- ── Carry-forward semantics ─────────────────────────────────────────
--
-- The existing carry-forward logic in NewVersionPage.tsx already
-- gates approval carry on image-set identity for the slot: every
-- v1 image carried unchanged, no fresh images for the slot. A
-- changed QR is a different file with a different storage path,
-- which breaks identity, which breaks carry — exactly what we
-- want. When carry DOES happen, NewVersionPage.tsx is updated in
-- a companion change to write qr_confirmed_at from the v1 row
-- into the carried v2 row, so the customer doesn't have to
-- re-tick on a version where their QRs are objectively unchanged.
-- This migration provides the column; the frontend wire-through
-- and the designer-override path (Mark as approved) writing
-- qr_confirmed_at = now() are handled in their respective TSX
-- files.
--
-- ── No data backfill ────────────────────────────────────────────────
--
-- Every existing approval predates this feature; the corresponding
-- proof_version_images rows all have is_qr_code = false, so the
-- predicate's "has any QR for this slot" check returns false and
-- the slot completes via the old rule. The new column defaults to
-- null and stays there for every legacy row.

begin;

-- ── 1. New column on proof_name_approvals ────────────────────────────

alter table proof_name_approvals
  add column qr_confirmed_at timestamptz;

comment on column proof_name_approvals.qr_confirmed_at is
  'Set when the customer ticks "I''ve verified my QR code contents" on '
  'their approval. Required by _finalize_proof_if_complete() for any '
  'slot whose coordinates include at least one QR row on the current '
  'version. Null when no QR is visible to the slot (the tick isn''t '
  'shown), when QRs exist but the customer hasn''t ticked yet, or on '
  'legacy approval rows that predate the QR feature.';

-- ── 2. Updated finalize predicate ────────────────────────────────────
--
-- Body is the 000128 / 000141 implementation plus a per-slot QR
-- confirmation check in the WHERE that counts approved slots. Top-
-- of-function structure is preserved so behaviour for QR-free
-- proofs is byte-identical to the previous shape.

create or replace function _finalize_proof_if_complete(p_proof_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version_id  uuid;
  v_current_names       text[];
  v_has_shared          boolean;
  v_has_any_qr          boolean;
  v_names_count         int;
  v_required_slots      int;
  v_approved_slots      int;
  v_proof_status        text;
begin
  -- Only finalize in_progress / dormant proofs
  select status
    into v_proof_status
    from proofs
    where id = p_proof_id;

  if v_proof_status not in ('in_progress', 'dormant') then
    return;
  end if;

  -- Load current version
  select id, names
    into v_current_version_id, v_current_names
    from proof_versions
    where proof_id = p_proof_id and is_current = true
    limit 1;

  if v_current_version_id is null then
    return;
  end if;

  v_names_count := coalesce(array_length(v_current_names, 1), 0);

  -- Shared (non-QR) images on the current version. Used to decide
  -- whether __shared__ is a required slot in the names-empty path.
  -- is_qr_code = false is required here: a QR row with
  -- associated_name IS NULL isn't an artwork image, so it doesn't
  -- imply a Shared artwork section exists.
  select exists (
    select 1
      from proof_version_images
      where proof_version_id = v_current_version_id
        and associated_name is null
        and is_qr_code = false
  ) into v_has_shared;

  -- Whether the current version has any QR row at all. Short-
  -- circuits the per-slot QR-confirmation check for QR-free
  -- versions so the predicate collapses back to the pre-QR rule.
  select exists (
    select 1
      from proof_version_images
      where proof_version_id = v_current_version_id
        and is_qr_code = true
  ) into v_has_any_qr;

  -- Required slots:
  --   * one per name, always
  --   * plus '__shared__' iff has_shared AND names is empty
  --     (the all-shared one-off path)
  v_required_slots := v_names_count
    + case when v_has_shared and v_names_count = 0 then 1 else 0 end;

  if v_required_slots = 0 then
    return;
  end if;

  -- Approved-slot count. Per slot, a row counts when:
  --   * its state = 'approved' (carry-forwards count toward
  --     completeness, same as 000128), AND
  --   * either the version has no QR codes (short-circuit),
  --     OR qr_confirmed_at is not null on the row,
  --     OR the slot's coordinates resolve to zero QRs (a slot
  --     with no QRs visible to it doesn't need the tick).
  --
  -- Slot coordinates for the QR predicate:
  --   * __shared__ (names empty): every QR on the version.
  --   * Named slot: QRs with associated_name = slot OR null
  --     (a shared QR is verified by every named recipient).
  select count(*)
    into v_approved_slots
    from proof_name_approvals pna
    where pna.proof_version_id = v_current_version_id
      and pna.state = 'approved'
      and (
        (pna.name = '__shared__' and v_has_shared and v_names_count = 0)
        or (pna.name = any(v_current_names))
      )
      and (
        not v_has_any_qr
        or pna.qr_confirmed_at is not null
        or not exists (
          select 1
            from proof_version_images pvi
            where pvi.proof_version_id = v_current_version_id
              and pvi.is_qr_code = true
              and (
                (pna.name = '__shared__' and v_names_count = 0)
                or pvi.associated_name = pna.name
                or pvi.associated_name is null
              )
        )
      );

  if v_approved_slots >= v_required_slots then
    update proofs
      set status = 'approved',
          approved_at = now()
      where id = p_proof_id
        and status in ('in_progress', 'dormant');
  end if;
end;
$$;

comment on function _finalize_proof_if_complete(uuid) is
  'Per-proof slot-completeness check used by the auto-finalize trigger '
  'and its sibling backfills. __shared__ counts as a required slot only '
  'when the current version has no named recipients (the all-shared one-'
  'off path); for split-name projects Shared is approved-by-implication. '
  'When the current version has any QR codes, a slot is only counted as '
  'approved if qr_confirmed_at is set on its approval row OR the slot''s '
  'coordinates resolve to zero QRs visible to it.';

commit;
