-- Migration 000144: rename proof_versions.is_mixed_materials to
-- is_per_direction_pricing.
--
-- Background. 000142 introduced is_mixed_materials as the boolean
-- discriminator for variant rounds where each direction carries its
-- own material and pricing is handled out-of-band. Designer feedback:
-- "mixed materials" is the wrong mental model. The actual decision
-- criterion is whether all directions share a single price tier or
-- whether each is priced individually — and per-direction pricing
-- can fire even when every direction is the same material family
-- (e.g. metal cards at different thicknesses, with different price
-- tiers). The column name now matches the decision criterion.
--
-- Rename only — no behavioural change. The trigger and view rebuild
-- inside this same migration so consumers don't transiently see a
-- missing column on the underlying table.
--
-- ── Deploy ordering ─────────────────────────────────────────────
--
-- This migration ships AFTER the bundle that reads
-- is_per_direction_pricing is live. For ~1-2 min before this is
-- pushed, the new bundle reads is_per_direction_pricing from the
-- old public view (still exposing is_mixed_materials), gets
-- undefined, and treats every variant round as non-per-direction.
-- Production has zero live per-direction-pricing variant rounds at
-- the time of this rename (the only such row in history is a test
-- fixture, currently superseded), so the transient is unobservable.
-- For any future rename of a column that does have live data, lift
-- this into a two-phase migration: alias-on-view first, drop alias
-- second.
--
-- ── Migration history ──────────────────────────────────────────
--
-- 000142 added the column with the old name. That history file is
-- preserved verbatim — it's the historical record of how the column
-- got there. Anyone reading 000144 alongside 000142 sees the rename
-- intent in this header.

begin;

-- ── 1. Rename the column ────────────────────────────────────────

alter table proof_versions
  rename column is_mixed_materials to is_per_direction_pricing;

comment on column proof_versions.is_per_direction_pricing is
  'True when this variant round prices each direction individually '
  '(out-of-band) rather than sharing one tier across every direction. '
  'Renamed from is_mixed_materials in 000144 — the original framing '
  'around material families turned out to be the wrong mental model: '
  'per-direction pricing fires whenever directions have different '
  'price tiers, including same-material-family-at-different-thicknesses '
  'cases. Requires is_variant_round = true. Implies material_id IS '
  'NULL, currency IS NULL, material_options = ''{}''. Default false.';

-- ── 2. Recreate validate_variant_round_proof_version ───────────
--
-- Function body identical to the 000142 definition with the column
-- name swapped throughout and raise messages updated to use the new
-- name. Trigger spec is unchanged from 000142.

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

  -- Per-direction pricing requires is_variant_round (000144).
  if new.is_per_direction_pricing and not new.is_variant_round then
    raise exception 'is_per_direction_pricing = true requires is_variant_round = true (per-direction pricing only applies to variant rounds)'
      using errcode = '23514';
  end if;

  -- Per-direction pricing: material_id, currency, material_options
  -- must all be empty. The customer page's per-direction-pricing
  -- branch hides the version-level pricing / spec / about sections;
  -- storing a material_id or currency on a per-direction row would
  -- be meaningless and could confuse future readers.
  if new.is_per_direction_pricing then
    if new.material_id is not null then
      raise exception 'is_per_direction_pricing = true requires material_id IS NULL'
        using errcode = '23514';
    end if;
    if new.currency is not null then
      raise exception 'is_per_direction_pricing = true requires currency IS NULL'
        using errcode = '23514';
    end if;
    if coalesce(array_length(new.material_options, 1), 0) > 0 then
      raise exception 'is_per_direction_pricing = true requires material_options = ''{}'' (no version-level option dimension)'
        using errcode = '23514';
    end if;
  end if;

  -- Shared-pricing versions (the default — !is_per_direction_pricing)
  -- retain the equivalent of the 000010 / 000011 NOT NULL constraints
  -- that 000142 dropped on material_id and currency. Without this, a
  -- standard or shared-pricing-variant-round version could save with
  -- NULL material_id and break every downstream read.
  if not new.is_per_direction_pricing then
    if new.material_id is null then
      raise exception 'material_id is required when is_per_direction_pricing = false'
        using errcode = '23514';
    end if;
    if new.currency is null then
      raise exception 'currency is required when is_per_direction_pricing = false'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function validate_variant_round_proof_version() is
  'BEFORE INSERT/UPDATE trigger on proof_versions. Enforces the '
  'single-bucket-only rule for variant rounds (000138) plus the '
  'per-direction-pricing invariants from 000142 (renamed in 000144): '
  'is_per_direction_pricing requires is_variant_round and forces '
  'material_id, currency, material_options to empty. Reasserts '
  'material_id / currency NOT NULL for shared-pricing versions, '
  'replacing the column-level NOT NULL constraints 000142 dropped.';

-- Trigger spec unchanged from 000142; re-state for completeness.
drop trigger if exists trg_validate_variant_round_proof_version on proof_versions;
create trigger trg_validate_variant_round_proof_version
  before insert or update on proof_versions
  for each row
  execute function validate_variant_round_proof_version();

-- ── 3. Rebuild public_proof_versions ──────────────────────────────
--
-- Same column set + ordering as 000142, with is_mixed_materials
-- renamed to is_per_direction_pricing. The customer page reads
-- this field via the view; the column rename above doesn't propagate
-- into the view definition automatically (Postgres binds view
-- columns to OIDs at definition time), so the drop+create here is
-- required to expose the new name.

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
    -- ── Per-direction pricing (000142 / renamed 000144) ──────────
    -- True only on variant-round versions where each direction
    -- carries its own price; gates the customer page's
    -- per-direction-pricing render branch (hides pricing card,
    -- spec section, about-material section, hero docket).
    pv.is_per_direction_pricing
  from proof_versions pv
  left join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

commit;
