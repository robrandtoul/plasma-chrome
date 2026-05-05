-- Migration 000135: front + back layer colours for letterpress proofs.
--
-- Migration 000133 introduced core_colour_id (the middle layer accent
-- visible at the card edge on un-gilded letterpress). This migration
-- completes the trio: front_colour_id and back_colour_id capture the
-- top and bottom layers of the three-layer Colorplan stack.
--
-- All three FKs point at the same letterpress_core_colours catalogue.
-- The "core" name in that table is now slightly legacy with respect
-- to its broader use, but renaming would touch a lot of surface for
-- no functional gain, so the catalogue stays as-is and the new
-- columns are named for their semantic role on the version.
--
-- Designer-side gating mirrors core_colour_id exactly: pickers and
-- panel only surface for material.code = 'paper_letterpress'. The
-- gilded SKU (paper_letterpress_gilded) hides the layered edge
-- behind the gilding, so it gets none of this UI.
--
-- View rebuild uses DROP + CREATE rather than CREATE OR REPLACE,
-- matching the pattern from 000125 and 000133. Postgres rejects
-- column-set changes on REPLACE, even when only appending — the
-- inner jsonb_build_object subqueries trip the same check. Drop
-- and recreate is the safe path.

begin;

-- ── 1. New FK columns + indexes ──────────────────────────────────────────────

alter table proof_versions
  add column front_colour_id uuid
    references letterpress_core_colours(id) on delete restrict;

alter table proof_versions
  add column back_colour_id uuid
    references letterpress_core_colours(id) on delete restrict;

create index proof_versions_front_colour_id_idx
  on proof_versions (front_colour_id);

create index proof_versions_back_colour_id_idx
  on proof_versions (back_colour_id);

-- ── 2. public_proof_versions view rebuild ────────────────────────────────────
-- Adds four columns via two left joins on letterpress_core_colours,
-- aliased to keep the front/back/core trio readable in the view
-- output. All other columns and projections are unchanged from the
-- 000133 definition. Re-grants select to anon + authenticated so
-- the customer page keeps reading.

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
          'helpscout_thread_id', e.helpscout_thread_id
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
    bc.hex_value        as back_colour_hex
  from proof_versions pv
  join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

commit;
