-- Migration 000212: finalisation for Set (collection) — layouts as approve-each slots.
--
-- Phase 2 step 2. A Set (collection) is approve-each: each layout is a
-- required approval slot, and the proof flips to approved only when
-- every layout is approved — exactly the Recipients rule, but with
-- layouts as the slot identity instead of names.
--
-- Only _finalize_proof_if_complete changes, as a create-or-replace. The
-- trigger (trg_maybe_finalize_proof_status), its wrapper
-- (maybe_finalize_proof_status), and the 000141 variant-round guard are
-- all left untouched. The wrapper's variant-round bail keys on
-- is_variant_round, which is false on a set_collection version, so the
-- guard correctly lets collections through while still stopping variant
-- rounds.
--
-- ── What's new vs 000169 ─────────────────────────────────────────────
--
-- 1. One extra declared variable, v_shape.
-- 2. The "load current version" select gains `, shape` / `, v_shape`.
-- 3. A new early-return branch handling shape = 'set_collection' only.
--
-- Everything from `v_names_count :=` to the end of the function is the
-- 000169 body, unchanged (the early-return means it is NOT re-indented,
-- so it stays byte-for-byte). Any proof whose shape is not
-- 'set_collection' — Recipients, Set (single), Selection, and every
-- legacy null-shape row — takes that unchanged path. The only added
-- cost for them is reading one extra column already on the version row.
--
-- ── Collection slot logic ────────────────────────────────────────────
--
--   Required slots  = count of proof_layouts on the current version.
--   Approved slots  = proof_name_approvals rows on the current version
--                     with state = 'approved' and name = a layout id
--                     (layout approvals are keyed name = layout_id::text,
--                     the receive-all analogue of the '__shared__'
--                     sentinel and the recipient-name key), passing the
--                     per-layout QR gate.
--   Flip to approved when approved >= required (every layout approved).
--
-- ── QR gate (mirrors 000169, keyed on layout_id) ─────────────────────
--
-- A layout slot counts as approved when its approval row is approved AND
-- one of:
--   * the version has no QR rows at all (version-wide short-circuit), OR
--   * qr_confirmed_at is set on the approval row, OR
--   * the layout has zero QR images visible to it (is_qr_code = true AND
--     layout_id = that layout) — so the tick isn't required for a
--     QR-free layout.
-- A QR-free collection therefore behaves identically to the plain
-- approve-each rule.
--
-- Inert on production: no live proof is set_collection, so the new
-- branch is never entered until the feature is used. The function still
-- runs for every proof via the unchanged path.

begin;

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
  v_shape               text;
begin
  -- Only finalize in_progress / dormant proofs
  select status
    into v_proof_status
    from proofs
    where id = p_proof_id;

  if v_proof_status not in ('in_progress', 'dormant') then
    return;
  end if;

  -- Load current version (shape added in 000212 to branch the slot
  -- logic; names still loaded for the unchanged non-collection path)
  select id, names, shape
    into v_current_version_id, v_current_names, v_shape
    from proof_versions
    where proof_id = p_proof_id and is_current = true
    limit 1;

  if v_current_version_id is null then
    return;
  end if;

  -- ── Set (collection) branch (000212) ────────────────────────────────
  -- Each layout is a required approve-each slot. Approval rows are keyed
  -- name = layout_id::text. The proof flips to approved only when every
  -- layout's row is approved (and passes the per-layout QR gate). Early
  -- return so the non-collection path below stays byte-for-byte 000169.
  if v_shape = 'set_collection' then
    select count(*)
      into v_required_slots
      from proof_layouts
      where proof_version_id = v_current_version_id;

    if v_required_slots = 0 then
      return;
    end if;

    -- Version-wide QR short-circuit (mirrors v_has_any_qr in 000169).
    select exists (
      select 1
        from proof_version_images
        where proof_version_id = v_current_version_id
          and is_qr_code = true
    ) into v_has_any_qr;

    -- Approved layout slots. The join to proof_layouts both restricts to
    -- layout-keyed approval rows and ignores any orphaned approval whose
    -- layout no longer exists on the current version. unique
    -- (proof_version_id, name) guarantees at most one row per layout.
    select count(*)
      into v_approved_slots
      from proof_name_approvals pna
      join proof_layouts pl
        on pl.proof_version_id = v_current_version_id
       and pl.id::text = pna.name
      where pna.proof_version_id = v_current_version_id
        and pna.state = 'approved'
        and (
          not v_has_any_qr
          or pna.qr_confirmed_at is not null
          or not exists (
            select 1
              from proof_version_images pvi
              where pvi.proof_version_id = v_current_version_id
                and pvi.is_qr_code = true
                and pvi.layout_id = pl.id
          )
        );

    if v_approved_slots >= v_required_slots then
      update proofs
        set status = 'approved',
            approved_at = now()
        where id = p_proof_id
          and status in ('in_progress', 'dormant');
    end if;

    return;
  end if;

  -- ── Non-collection path: byte-for-byte 000169 from here down ─────────

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
  'and its sibling backfills. For shape = ''set_collection'', every '
  'proof_layouts row is a required approve-each slot (approvals keyed '
  'name = layout_id::text) with the QR gate keyed on layout_id; the '
  'proof approves when all layouts are approved. Every other shape '
  '(including legacy null) uses the unchanged names/__shared__ logic '
  'from 000169: __shared__ counts as a required slot only when the '
  'current version has no named recipients, and a slot with any QR '
  'visible to it must have qr_confirmed_at set.';

commit;
