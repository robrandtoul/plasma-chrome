-- Migration 000118: proof_versions.displayed_variant_ids — restore
-- the per-version variant subset lost in the Phase 2 snapshot flip.
--
-- Until Phase 2, the variants the customer saw on a proof's pricing
-- grid were encoded inside proof_versions.pricing_snapshot — each
-- entry of snapshot.variants[] named one variant_id, and the
-- customer page rendered exactly that set. When migration 000117
-- flipped the customer page from snapshot to live pricing, the page
-- started showing every active variant of the version's material
-- because there was no other column carrying the designer's choice.
-- That widened the customer view beyond intent for any proof where
-- the designer had deliberately offered a subset (e.g. "300µ only,
-- not 500µ or 800µ"), and it broke v2+ variant carry-forward in
-- NewVersionPage which read its pre-fill set from the same place.
--
-- This migration adds an explicit column for the variant subset and
-- keeps the snapshot column purely as a historical record:
--
--   displayed_variant_ids uuid[] NULL
--
-- Null semantics:
--   * NULL    = "no curation captured" — the customer page falls
--               through to its prior post-Phase-2 behaviour (show
--               every active variant of the material). This is the
--               safe fallback for any post-Phase-2 row that was
--               inserted before this column was added (the test v2
--               from Phase 2 verification was already deleted, so
--               in practice no such rows exist on prod, but the
--               fallback is the right shape regardless).
--   * uuid[] = explicit subset, possibly empty (custom-quote
--              versions have no pricing grid; an empty array is
--              valid).
--
-- ── Backfill ────────────────────────────────────────────────────
--
-- Existing rows with a populated pricing_snapshot get their
-- displayed_variant_ids derived from snapshot.variants[].variant_id.
-- The earlier Code investigation called the field "id"; the actual
-- shape (verified during this commit) is variant_id, so the SQL
-- below uses ->>'variant_id'. The UPDATE is guarded by
-- displayed_variant_ids IS NULL so re-running the migration is a
-- no-op even if the snapshot data later evolves.
--
-- ── View ────────────────────────────────────────────────────────
--
-- The customer page (anon) needs to read displayed_variant_ids to
-- apply the filter, so public_proof_versions is rebuilt with the
-- column appended. Using CREATE OR REPLACE because PostgreSQL
-- allows column-list extension at the end without a drop+create —
-- only column reorder or rename forces a rebuild.

begin;

alter table proof_versions
  add column if not exists displayed_variant_ids uuid[] null;

comment on column proof_versions.displayed_variant_ids is
  'Variant IDs the designer chose to offer on this version''s '
  'pricing grid. NULL means "no curation" — the customer page '
  'falls back to showing every active variant of the material. '
  'Empty array is valid (e.g. custom-quote versions). Backfilled '
  'from pricing_snapshot.variants[].variant_id by migration '
  '000118; written directly by NewVersionPage from this commit on. '
  'Replaces the variant-selection role pricing_snapshot held until '
  'Phase 2 — pricing_snapshot itself stays as a frozen historical '
  'record only.';

update proof_versions
  set displayed_variant_ids = (
    select array_agg((variant_obj->>'variant_id')::uuid)
    from jsonb_array_elements(pricing_snapshot->'variants') as variant_obj
    where variant_obj->>'variant_id' is not null
  )
  where pricing_snapshot is not null
    and displayed_variant_ids is null;

create or replace view public_proof_versions as
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
          'carried_from_version_id', pna.carried_from_version_id
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
    pv.displayed_variant_ids
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
