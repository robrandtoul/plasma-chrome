-- Migration 000070: capture per-version split-name tooling on
-- proof_versions so the customer proof page can surface the
-- surcharge and the names it applies to.
--
-- Context: materials.split_name_surcharge_{gbp,eur,usd} already
-- stores the per-extra-name tooling surcharge. Nothing was pulling
-- that into the version snapshot, so neither the customer page
-- nor the designer's audit had a record of it. This migration
-- plumbs it through.
--
-- Two columns:
--   names text[] NOT NULL default '{}'
--     The named recipients for this version's proof. Captured
--     per-version (snapshot) so v1's names persist even if the
--     designer edits v2 to a different list.
--   split_name_surcharge_snapshot numeric null
--     The per-extra-name tooling surcharge in the version's
--     currency at creation/update time, pulled from the version's
--     material. Null when the material has no surcharge for that
--     currency (carbon CNC, some paper). Null is meaningful —
--     the customer page uses it to decide whether to render the
--     tooling panel.
--
-- Trigger BEFORE INSERT OR UPDATE reads
-- materials.split_name_surcharge_<currency> via material_variants
-- and stamps NEW.split_name_surcharge_snapshot. Trigger keeps the
-- snapshot in sync with the version's current material + currency
-- across material swaps on edit.
--
-- View extension: expose names + split_name_surcharge_snapshot on
-- public_proof_versions so the customer page can read them.
-- currency is already exposed.

begin;

-- ── Columns ─────────────────────────────────────────────────────────────────

alter table proof_versions
  add column names                          text[]  not null default '{}',
  add column split_name_surcharge_snapshot  numeric null;

comment on column proof_versions.names is
  'Named recipients for this version (e.g. directors on a split '
  'metal order). Snapshot — each version keeps its own list.';
comment on column proof_versions.split_name_surcharge_snapshot is
  'Per-extra-name tooling surcharge in this version''s currency, '
  'snapshotted from the version''s material at INSERT/UPDATE time '
  'by the proof_versions_snapshot_split_name_surcharge trigger. '
  'Null when the material has no configured surcharge for the '
  'chosen currency.';

-- ── Trigger function ────────────────────────────────────────────────────────

create or replace function snapshot_split_name_surcharge()
returns trigger language plpgsql as $$
declare
  surcharge numeric;
begin
  -- Look up the material via material_variants, then pick the
  -- currency-specific surcharge column. Materials row is the
  -- source of truth; this just caches the relevant number onto
  -- the version.
  select case new.currency
           when 'GBP' then m.split_name_surcharge_gbp
           when 'EUR' then m.split_name_surcharge_eur
           when 'USD' then m.split_name_surcharge_usd
           else null
         end
    into surcharge
    from material_variants mv
    join materials m on m.id = mv.material_id
    where mv.id = (
      -- Multi-variant versions share one material, so any variant
      -- in the version's material_options list resolves to the
      -- same parent material. Take the first-found variant whose
      -- id belongs to this version's material, via the
      -- version's material_id directly (which proof_versions
      -- already carries).
      select id from material_variants
        where material_id = new.material_id
        limit 1
    );

  new.split_name_surcharge_snapshot := surcharge;
  return new;
end;
$$;

create trigger proof_versions_snapshot_split_name_surcharge
  before insert or update on proof_versions
  for each row execute function snapshot_split_name_surcharge();

-- Backfill existing rows so historical versions carry the correct
-- snapshot. Disable bump_proof_activity first to avoid the same
-- trap 000068 hit: the cascade into proofs.last_activity_at
-- would trip the helpscout_link_or_override check for any
-- proof that somehow still sits in a pre-000069 state (shouldn't
-- happen after the 000069 backfill but defensive).
alter table proof_versions disable trigger proof_versions_bump_activity;

-- Fire the snapshot trigger by re-writing the material_id column
-- to itself. Cheaper than a no-op UPDATE on every column.
update proof_versions set material_id = material_id;

alter table proof_versions enable trigger proof_versions_bump_activity;

-- ── View: expose names + split_name_surcharge_snapshot ──────────────────────

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
    pv.superseded_at,
    pv.names,
    pv.split_name_surcharge_snapshot
  from proof_versions pv
  join materials m on m.id = pv.material_id;
grant select on public_proof_versions to anon, authenticated;

commit;
