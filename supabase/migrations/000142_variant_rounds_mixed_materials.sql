-- Migration 000142: variant rounds — mixed-materials sub-mode.
--
-- Variant rounds shipped in 000138 with a single shared material
-- across every variant. This migration adds a second sub-mode where
-- each variant can be a different material — typical use: comparing
-- a metal direction against a wood direction against a paper
-- direction in one round. Pricing for mixed-materials rounds is
-- handled out-of-band (the customer is told prices are in the email);
-- the customer page hides its pricing card, spec sheet, and
-- material-about block on these versions.
--
-- ── New column ───────────────────────────────────────────────────────
--
--   proof_versions.is_mixed_materials  boolean not null default false
--
-- Defaults false. Every existing row — standard proofs and the
-- single-material variant rounds shipped in 000138 — keeps the
-- existing behaviour. Only versions explicitly created in mixed-
-- materials mode flip this true.
--
-- ── Loosened NOT NULL constraints ───────────────────────────────────
--
-- Mixed-materials rounds have no version-level material or currency
-- — both are per-variant decisions handled separately. We DROP
-- NOT NULL on:
--
--   proof_versions.material_id   (was 000011 NOT NULL)
--   proof_versions.currency      (was 000010 NOT NULL)
--
-- The trigger below reasserts the equivalent constraints for the
-- 99.9% of versions that are NOT mixed-materials, so a standard or
-- single-material-variant-round version still can't accidentally
-- save without a material_id / currency.
--
-- ── Trigger: extend validate_variant_round_proof_version ────────────
--
-- The 000138 trigger already enforces "is_variant_round = true →
-- names is empty". This migration extends it to cover the new
-- mixed-materials invariants and the loosened NOT NULLs:
--
--   * is_mixed_materials = true requires is_variant_round = true
--     (mixed materials outside a variant round is nonsensical).
--   * is_mixed_materials = true requires material_id IS NULL,
--     currency IS NULL, and material_options = '{}'.
--   * is_mixed_materials = false requires material_id IS NOT NULL
--     and currency IS NOT NULL — replaces the dropped NOT NULL
--     constraints with mode-aware enforcement.
--
-- Mirrors the proof_version_images trigger pattern from 000138 —
-- BEFORE INSERT/UPDATE on proof_versions, RAISE EXCEPTION with
-- errcode '23514' so callers see a clean check_violation rather
-- than a generic raise.
--
-- ── Public view rebuild ─────────────────────────────────────────────
--
-- public_proof_versions appends pv.is_mixed_materials. Same drop+
-- create pattern as 000139 — column-list extension only at the end
-- is fine for CREATE OR REPLACE, but the existing rebuild idiom is
-- drop+create, so we follow it here too. Re-grants SELECT to anon +
-- authenticated as defence in depth (matches the 000118 / 000121 /
-- 000125 / 000133 / 000135 / 000139 idiom).
--
-- ── Behaviour invariants on existing rows ───────────────────────────
--
-- Every existing public_proof_versions row has
--   is_mixed_materials = false   (default; the column is never NULL)
-- The customer page's mixed-materials branch is gated on
-- (is_variant_round && is_mixed_materials), both of which evaluate
-- false on every row in production today, so the standard render
-- path remains exactly as before.

begin;

-- ── 1. New column ────────────────────────────────────────────────────

alter table proof_versions
  add column if not exists is_mixed_materials boolean not null default false;

comment on column proof_versions.is_mixed_materials is
  'True when this variant round mixes materials across variants — '
  'each variant carries its own material, pricing is handled out-of-'
  'band, and the customer page hides the pricing / specification / '
  'about-material sections. Requires is_variant_round = true. '
  'Implies material_id IS NULL, currency IS NULL, material_options = '
  '''{}''. Default false; every pre-000142 row preserves the existing '
  'single-material behaviour. Enforced by '
  'validate_variant_round_proof_version().';

-- ── 2. Loosen NOT NULL on material_id + currency ─────────────────────
-- DROP NOT NULL is idempotent in PostgreSQL — re-applying is a no-op.

alter table proof_versions alter column material_id drop not null;
alter table proof_versions alter column currency    drop not null;

-- ── 3. Replace validate_variant_round_proof_version ──────────────────
--
-- 000138's body checked only the names-roster invariant. This rewrite
-- adds the mixed-materials and material/currency invariants so
-- everything proof_versions cares about for variant-round and
-- mixed-materials state lives in one place. Trigger spec is
-- unchanged from 000138 (BEFORE INSERT/UPDATE on proof_versions).

create or replace function validate_variant_round_proof_version()
returns trigger
language plpgsql
as $$
begin
  -- Variant rounds: no recipient roster (000138).
  if new.is_variant_round
     and coalesce(array_length(new.names, 1), 0) > 0 then
    raise exception 'variant-round versions cannot have a recipient roster (proof_versions.names must be empty when is_variant_round = true)'
      using errcode = '23514';
  end if;

  -- Mixed-materials sub-mode requires is_variant_round (000142).
  if new.is_mixed_materials and not new.is_variant_round then
    raise exception 'is_mixed_materials = true requires is_variant_round = true (mixed materials only applies to variant rounds)'
      using errcode = '23514';
  end if;

  -- Mixed-materials: material_id, currency, material_options must
  -- all be empty. The customer page's mixed-materials branch hides
  -- the version-level pricing / spec / about sections; storing a
  -- material_id or currency on a mixed-materials row would be
  -- meaningless and could confuse future readers.
  if new.is_mixed_materials then
    if new.material_id is not null then
      raise exception 'is_mixed_materials = true requires material_id IS NULL'
        using errcode = '23514';
    end if;
    if new.currency is not null then
      raise exception 'is_mixed_materials = true requires currency IS NULL'
        using errcode = '23514';
    end if;
    if coalesce(array_length(new.material_options, 1), 0) > 0 then
      raise exception 'is_mixed_materials = true requires material_options = ''{}'' (no version-level option dimension)'
        using errcode = '23514';
    end if;
  end if;

  -- Non-mixed-materials versions retain the equivalent of the
  -- 000010 / 000011 NOT NULL constraints we just dropped on
  -- material_id and currency. Without this, a standard or single-
  -- material-variant-round version could save with NULL material_id
  -- and break every downstream read.
  if not new.is_mixed_materials then
    if new.material_id is null then
      raise exception 'material_id is required when is_mixed_materials = false'
        using errcode = '23514';
    end if;
    if new.currency is null then
      raise exception 'currency is required when is_mixed_materials = false'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function validate_variant_round_proof_version() is
  'BEFORE INSERT/UPDATE trigger on proof_versions. Enforces the '
  'single-bucket-only rule for variant rounds (000138) plus the '
  'mixed-materials invariants from 000142: is_mixed_materials '
  'requires is_variant_round and forces material_id, currency, '
  'material_options to empty. Reasserts material_id / currency '
  'NOT NULL for non-mixed-materials versions, replacing the column-'
  'level NOT NULL constraints we dropped in this same migration.';

-- Trigger spec is unchanged from 000138; re-state for completeness.
drop trigger if exists trg_validate_variant_round_proof_version on proof_versions;
create trigger trg_validate_variant_round_proof_version
  before insert or update on proof_versions
  for each row
  execute function validate_variant_round_proof_version();

-- ── 4. public_proof_versions rebuild ─────────────────────────────────
--
-- Appends is_mixed_materials at the end. Drop+create rather than
-- CREATE OR REPLACE for consistency with the prior rebuilds (000121
-- / 000125 / 000133 / 000135 / 000139); CREATE OR REPLACE would
-- accept the column-list extension here, but the inner subselect
-- shape doesn't change either way and the explicit drop+create
-- keeps the migration body easy to grep.

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
    m.disclaimer        as material_disclaimer,
    m.description       as material_description,
    m.icon_url          as material_icon_url,
    m.option_label,
    pv.custom_quote,
    pv.superseded_at,
    pv.names,
    pv.split_name_surcharge_snapshot,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', pna.name,
          'state', pna.state,
          'carried_from_version_id', pna.carried_from_version_id,
          'material_option_code', pna.material_option_code
        )),
        '[]'::jsonb
      )
      from proof_name_approvals pna
      where pna.proof_version_id = pv.id
    ) as approvals,
    pv.card_type,
    m.display_quantities,
    m.quote_min_quantity,
    m.quote_max_quantity,
    m.key_features,
    pv.displayed_variant_ids,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', e.name,
          'event_type', e.event_type,
          'actor_name', e.actor_name,
          'comment', e.comment,
          'created_at', e.created_at,
          'helpscout_thread_id', e.helpscout_thread_id,
          'material_option_code', e.material_option_code,
          'round_variant_id', e.round_variant_id
        )),
        '[]'::jsonb
      )
      from (
        select distinct on (proof_version_id, name) *
        from proof_events
        where proof_version_id = pv.id
        order by proof_version_id, name, created_at desc
      ) e
    ) as latest_events_by_name,
    s.approvals_enabled as approvals_enabled,
    cc.name             as core_colour_name,
    cc.hex_value        as core_colour_hex,
    fc.name             as front_colour_name,
    fc.hex_value        as front_colour_hex,
    bc.name             as back_colour_name,
    bc.hex_value        as back_colour_hex,
    pv.is_variant_round,
    (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id',           rv.id,
            'code',         rv.code,
            'display_name', rv.display_name,
            'sort_order',   rv.sort_order
          )
          order by rv.sort_order, rv.code
        ),
        '[]'::jsonb
      )
      from proof_round_variants rv
      where rv.proof_version_id = pv.id
    ) as round_variants,
    -- ── Mixed materials (000142) ─────────────────────────────────
    -- True only on variant-round versions where each variant
    -- carries its own material; gates the customer page's
    -- mixed-materials render branch (build-plan step D).
    pv.is_mixed_materials
  from proof_versions pv
  left join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

commit;
