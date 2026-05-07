-- Migration 000139: variant rounds — public view exposure (step 2, dark).
--
-- Surfaces the variant-rounds schema added by 000138 on the customer-
-- facing public_* views so the customer page (step 4) can detect
-- variant rounds, render the comparison grid, and read the locked-
-- round state on a refreshed page without an extra query.
--
-- Three view shape changes:
--
-- 1. public_proof_versions
--      append:  is_variant_round  boolean
--      append:  round_variants    jsonb (ordered by sort_order, code)
--      mutate:  latest_events_by_name extended with two new fields per
--               entry — material_option_code and round_variant_id —
--               needed by step 4's locked-round detection (the chosen
--               variant id has to round-trip through this surface so
--               the customer page renders the correct selection on
--               first paint after refresh). material_option_code on
--               this projection has been a "out of scope, trivial to
--               add when a consumer needs it" gap since 000125; step
--               4 is that consumer, so the gap closes here.
--
-- 2. public_proof_version_images
--      append:  round_variant_id  uuid
--
-- ── Drop + create vs. create or replace ──────────────────────────────
--
-- public_proof_versions changes the inner jsonb_build_object shape of
-- latest_events_by_name. PostgreSQL's CREATE OR REPLACE VIEW only
-- allows column-list extension at the end of the OUTER select; any
-- mutation inside a subselect that produces a structurally different
-- jsonb is treated as a column-type change and rejected. Same case
-- 000121 / 000125 / 000133 / 000135 hit. So this view is drop-then-
-- create.
--
-- public_proof_version_images appends a flat column to the outer
-- select with no inner-shape change, so CREATE OR REPLACE is fine
-- (and idempotent).
--
-- ── Anon grants ──────────────────────────────────────────────────────
--
-- Both views explicitly re-grant SELECT to anon + authenticated after
-- the rebuild. CREATE OR REPLACE preserves grants in current
-- PostgreSQL but the explicit re-grant is defence in depth — a future
-- refactor that switches the second view to drop+create can't
-- silently strip anon access. Same idiom as 000118 / 000121 / 000125 /
-- 000133 / 000135.
--
-- ── Behaviour invariants on existing rows ────────────────────────────
--
-- After this migration, every existing public_proof_versions row has
--   is_variant_round = false        (000138 default)
--   round_variants    = '[]'::jsonb (no proof_round_variants rows yet)
-- Every existing public_proof_version_images row has
--   round_variant_id  = null        (000138 default)
-- Every existing latest_events_by_name entry has
--   material_option_code = its proof_events.material_option_code
--                          (already populated since 000124 where
--                          applicable; null otherwise)
--   round_variant_id     = null     (000138 default; events pre-dating
--                                     variant rounds carry no variant id)
--
-- App code in this commit reads none of these fields — step 4 picks
-- them up.

begin;

-- ── 1. public_proof_versions ─────────────────────────────────────────

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
    -- Per-recipient latest events (000121, +000125 carried the gap
    -- on material_option_code, +000139 closes that gap and adds
    -- round_variant_id). DISTINCT ON (proof_version_id, name) ORDER
    -- BY created_at DESC collapses the append-only event stream to
    -- one entry per (version, name) pair. For variant rounds (always
    -- name='__shared__') this yields the most recent direction the
    -- customer selected — exactly what step 4's locked-round render
    -- needs on refresh. Filtering by event_type stays a customer-
    -- page concern.
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
    -- ── Variant rounds (000138 + 000139) ─────────────────────────────
    -- is_variant_round flips the customer-page render branch from
    -- the standard per-recipient bands to the side-by-side variant
    -- comparison grid (step 4). round_variants is the ordered list
    -- of parallel variants on the round; '[]'::jsonb on every
    -- standard version (and '[]'::jsonb on variant-round versions
    -- until step 5's upload UI starts writing rows).
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
    ) as round_variants
  from proof_versions pv
  join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

-- ── 2. public_proof_version_images ───────────────────────────────────

create or replace view public_proof_version_images as
  select
    id,
    proof_version_id,
    image_path,
    sort_order,
    material_option,
    original_filename,
    associated_name,
    side,
    round_variant_id
  from proof_version_images;

grant select on public_proof_version_images to anon, authenticated;

commit;
