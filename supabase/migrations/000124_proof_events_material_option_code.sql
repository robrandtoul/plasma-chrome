-- Migration 000124: per-action material_option_code on the approval surface.
--
-- Records which material_options.code (e.g. 'natural', 'brushed', 'mirror'
-- for metal; 'black_walnut', 'finnish_birch' for wood; 'with_cutting' for
-- carbon fibre) was active in the customer's tab when they clicked
-- Approve / Request Changes. Applies cleanly to versions that carry a
-- material_options dimension; null for everything else (no option
-- dimension on this material, OR row created before this migration).
--
-- Stored as text (the code) rather than uuid (material_options.id) to
-- mirror the surrounding columns:
--   * proof_versions.material_options       text[]   (set membership)
--   * proof_version_images.material_option  text     (per-image scope)
-- The whole subsystem keys on codes; switching to a uuid FK here
-- would create a join-asymmetry inside the same dimensional concept.
-- Codes are also stable for the materials that already shipped (the
-- 000020 / 000025 / 000026 seed data is locked in production), so the
-- "FK protects against renames" argument doesn't cash out in practice.
--
-- Dual-write reality: the proof-action edge function writes proof_events
-- and proof_name_approvals as two sequential Supabase REST calls, not
-- as a single transaction. If proof_events lands but the
-- proof_name_approvals upsert fails, the response is `{ status:
-- 'partial', reason: 'proof_name_approvals_sync_failed' }` and the
-- two tables diverge on whatever the second write would have copied.
-- This new column inherits that same best-effort consistency model —
-- the mirror across both tables is documentation/ergonomics, not a
-- hard invariant. A future ship can wrap the dual-write in an RPC
-- to make it atomic; that's a separate change.
--
-- CHECK clause shape: PostgreSQL rejects subqueries in CHECK constraints,
-- so the "code must be a member of the parent's material_options array"
-- rule is enforced as a row-level trigger instead. Same effect at the
-- BEFORE INSERT/UPDATE point, but lifted out of the CHECK declaration.
--
-- Backfill: only rows whose parent proof_versions.material_options
-- array has exactly one element are backfilled. For those, the active
-- option at action time is unambiguous — there was nothing else to
-- pick. Multi-option versions (the case this column actually solves
-- for) are left at null because we genuinely don't know which option
-- was active for those historic events.

begin;

-- ── 1. proof_events.material_option_code ─────────────────────────────────────

alter table proof_events
  add column material_option_code text null;

comment on column proof_events.material_option_code is
  'The material_options.code that was active in the customer''s tab '
  'when they clicked Approve / Request Changes. Null when the parent '
  'proof_versions row has no material_options dimension, OR for events '
  'recorded before migration 000124. Stored as a code (text) rather '
  'than a uuid FK to mirror proof_versions.material_options text[] and '
  'proof_version_images.material_option text — the whole option '
  'subsystem keys on codes.';

create or replace function proof_events_validate_material_option_code()
returns trigger language plpgsql as $$
declare
  parent_options text[];
begin
  if new.material_option_code is null then
    return new;
  end if;
  select pv.material_options into parent_options
    from proof_versions pv
    where pv.id = new.proof_version_id;
  if parent_options is null then
    -- proof_version_id FK already validates existence; this branch
    -- only fires for the trigger-runs-before-FK edge case. Defer to
    -- the FK by accepting; the FK will reject the row anyway.
    return new;
  end if;
  if not (new.material_option_code = any(parent_options)) then
    raise exception
      'material_option_code "%" is not a member of proof_versions.material_options (% members) for proof_version_id %',
      new.material_option_code,
      coalesce(array_length(parent_options, 1), 0),
      new.proof_version_id
      using errcode = '23514';  -- check_violation
  end if;
  return new;
end;
$$;

create trigger proof_events_check_material_option_code
  before insert or update of material_option_code, proof_version_id
  on proof_events
  for each row
  execute function proof_events_validate_material_option_code();

-- ── 2. proof_name_approvals.material_option_code ─────────────────────────────

alter table proof_name_approvals
  add column material_option_code text null;

comment on column proof_name_approvals.material_option_code is
  'Mirror of proof_events.material_option_code on the latest accepted '
  'event for this (proof_version_id, name) pair. Lets dashboard '
  'projections show "approved (brushed)" without joining proof_events. '
  'Subject to the same best-effort consistency as the rest of the '
  'proof_name_approvals dual-write — see proof-action/index.ts for the '
  'partial-failure path. Null semantics match proof_events (no option '
  'dimension OR pre-migration row).';

create or replace function proof_name_approvals_validate_material_option_code()
returns trigger language plpgsql as $$
declare
  parent_options text[];
begin
  if new.material_option_code is null then
    return new;
  end if;
  select pv.material_options into parent_options
    from proof_versions pv
    where pv.id = new.proof_version_id;
  if parent_options is null then
    return new;
  end if;
  if not (new.material_option_code = any(parent_options)) then
    raise exception
      'material_option_code "%" is not a member of proof_versions.material_options (% members) for proof_version_id %',
      new.material_option_code,
      coalesce(array_length(parent_options, 1), 0),
      new.proof_version_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger proof_name_approvals_check_material_option_code
  before insert or update of material_option_code, proof_version_id
  on proof_name_approvals
  for each row
  execute function proof_name_approvals_validate_material_option_code();

-- ── 3. Lossless backfill — single-option parents only ────────────────────────
--
-- For versions whose material_options array has exactly one element,
-- the active option at action time was unambiguous: there was only
-- one option to be on. Backfill those rows so the "approved" pill on
-- the designer dashboard can show e.g. "(brushed)" for historic
-- single-finish events without having to fall back to "(unknown)".
--
-- array_length(arr, 1) returns NULL for empty arrays (materials with
-- no option dimension at all), so the WHERE clause naturally excludes
-- those. Multi-option arrays are also excluded — the active option
-- there is genuinely unknown for historic events.

update proof_events e
   set material_option_code = pv.material_options[1]
  from proof_versions pv
 where pv.id = e.proof_version_id
   and array_length(pv.material_options, 1) = 1
   and e.material_option_code is null;

update proof_name_approvals a
   set material_option_code = pv.material_options[1]
  from proof_versions pv
 where pv.id = a.proof_version_id
   and array_length(pv.material_options, 1) = 1
   and a.material_option_code is null;

commit;
