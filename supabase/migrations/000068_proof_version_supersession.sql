-- Migration 000068: supersession and approval-in-context columns on
-- proof_versions
--
-- Phase 2 of the customer proof page needs three things that don't
-- exist today:
--   1. A way to tell whether a version is the chronologically-latest
--      for its proof (so the customer page can render a "newer
--      version available" banner on an older one).
--   2. A way to record, at Approve time, whether the version the
--      customer approved was the current-latest or a superseded one.
--   3. Both signals available at the view layer for the customer
--      query, without breaking the existing read path.
--
-- This migration adds the plumbing; no UI reads either column yet.
--
-- Deletion semantics (see the Phase 2 discovery):
--   Hard delete exists via the per-version modal and the
--   delete_proof_cascade RPC. When a version is deleted, we want the
--   "chronologically-latest" invariant to hold without manual
--   repair. An AFTER DELETE trigger clears superseded_at on the new
--   latest if the deleted row was itself the current-latest. No
--   attempt at middle-row recomputation — the stale stamp on an
--   older sibling stays harmless (the banner says "newer version
--   available", which remains true, just referring one link back in
--   the chain rather than immediately).
--
-- Out-of-order insert defence:
--   App never inserts out of order today. The defence below handles
--   a hypothetical historical-import path by stamping NEW's own
--   superseded_at when it lands chronologically earlier than an
--   existing sibling.
--
-- What isn't here:
--   * No check constraint tying approved_while_superseded to
--     approved_at. Phase 2 code will set them atomically; the
--     constraint adds rigidity for no current gain.
--   * No customer-facing exposure of approved_while_superseded. It's
--     a designer / audit field.

begin;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

alter table proof_versions
  add column superseded_at           timestamptz null,
  add column approved_while_superseded boolean not null default false;

comment on column proof_versions.superseded_at is
  'Timestamp the version was replaced by a newer version of the same '
  'proof. Stamped by the AFTER INSERT trigger using the new '
  'version''s created_at. Null while current. Cleared on the new '
  'latest by the AFTER DELETE trigger when the current-latest is '
  'deleted.';

comment on column proof_versions.approved_while_superseded is
  'True if the customer clicked Approve on this version while it had '
  'a non-null superseded_at. Set by Phase 2 approval code, never by '
  'the trigger. Designer/audit field — not exposed to customers.';

-- ── 2. Backfill existing rows ───────────────────────────────────────────────
--
-- For every proof, stamp each version except the chronologically-last
-- with the next version''s created_at. LEAD returns null for the last
-- row in each partition, which we want left null.
--
-- Trigger collision note:
--   bump_proof_activity (000018) fires on every proof_versions UPDATE
--   and cascades to `update proofs set last_activity_at = now()`.
--   That cascade trips the proofs_helpscout_link_or_override_chk
--   check from 000067 against any historical proof that has null for
--   both helpscout columns. Disabling the bump trigger for the
--   duration of the backfill keeps the migration moving and avoids
--   rewriting last_activity_at values we don''t want to touch anyway
--   (this is a schema migration, not an app-level activity event).
--   Separately, the broader "000067 freezes historical null/null
--   proofs from any UPDATE" issue is a live bug — see the report.

alter table proof_versions disable trigger proof_versions_bump_activity;

update proof_versions pv
set superseded_at = sub.next_created_at
from (
  select
    id,
    lead(created_at) over (
      partition by proof_id order by created_at
    ) as next_created_at
  from proof_versions
) sub
where pv.id = sub.id
  and sub.next_created_at is not null;

alter table proof_versions enable trigger proof_versions_bump_activity;

-- ── 3. Partial index for "find current version" ─────────────────────────────

create index proof_versions_current_idx
  on proof_versions (proof_id)
  where superseded_at is null;

-- ── 4. AFTER INSERT trigger: stamp supersession ─────────────────────────────

create or replace function stamp_supersession_on_insert()
returns trigger language plpgsql as $$
declare
  newer_sibling_created_at timestamptz;
begin
  -- Common case: NEW is chronologically-latest. Stamp any existing
  -- unsuperseded siblings that are strictly older than NEW.
  update proof_versions
  set superseded_at = new.created_at
  where proof_id = new.proof_id
    and id <> new.id
    and superseded_at is null
    and created_at < new.created_at;

  -- Defence against historical imports: if NEW is chronologically
  -- older than an existing sibling, it's born already superseded.
  -- Stamp its own superseded_at to the earliest chronologically-newer
  -- sibling''s created_at.
  select min(created_at)
  into newer_sibling_created_at
  from proof_versions
  where proof_id = new.proof_id
    and id <> new.id
    and created_at > new.created_at;

  if newer_sibling_created_at is not null then
    update proof_versions
    set superseded_at = newer_sibling_created_at
    where id = new.id;
  end if;

  return null;
end;
$$;

create trigger proof_versions_stamp_supersession
  after insert on proof_versions
  for each row execute function stamp_supersession_on_insert();

-- ── 5. AFTER DELETE trigger: clear supersession on new latest ───────────────

create or replace function clear_supersession_on_delete()
returns trigger language plpgsql as $$
begin
  -- Only care when the deleted row was itself the current-latest. If
  -- it was already superseded, deleting it doesn't change which
  -- surviving sibling is the latest.
  if old.superseded_at is not null then
    return old;
  end if;

  -- Find the next chronologically-latest surviving sibling and clear
  -- its superseded_at. If no survivors (cascade delete wiping all
  -- versions of a proof), the UPDATE targets nothing — no-op.
  update proof_versions
  set superseded_at = null
  where id = (
    select id from proof_versions
    where proof_id = old.proof_id
      and id <> old.id
    order by created_at desc
    limit 1
  );

  return old;
end;
$$;

create trigger proof_versions_clear_supersession_on_delete
  after delete on proof_versions
  for each row execute function clear_supersession_on_delete();

-- ── 6. Extend public_proof_versions view ────────────────────────────────────
--
-- Adds superseded_at. approved_while_superseded stays out — the
-- customer page shouldn't know about it.

drop view if exists public_proof_versions;
create view public_proof_versions as
  select
    pv.id,
    pv.proof_id,
    pv.version_number,
    pv.material_id,
    pv.material_display,
    pv.ink_names,
    pv.currency,
    pv.pricing_snapshot,
    pv.shipping_note,
    pv.change_notes,
    pv.is_current,
    pv.created_at,
    pv.material_options,
    m.featured_quantities,
    m.disclaimer        as material_disclaimer,
    m.description       as material_description,
    m.icon_url          as material_icon_url,
    m.option_label,
    pv.custom_quote,
    pv.superseded_at
  from proof_versions pv
  join materials m on m.id = pv.material_id;
grant select on public_proof_versions to anon, authenticated;

commit;
