-- Migration 000025: generalise finishes → material_options, seed wood species
--
-- The finishes pattern (designer multi-select + customer switcher) turned out
-- to be more general than just metal finishes. Wood has five species that use
-- the same UX and data shape, just with no surcharges. Renaming the tables
-- and columns here lets wood species live alongside metal finishes without
-- shoehorning the label.
--
-- Customer-facing labels stay material-specific via a new materials.option_label
-- column ("Finish" for metals, "Species" for wood).

begin;

-- ── 1. Rename tables and columns ──────────────────────────────────────────────

alter table finishes rename to material_options;
alter table finish_surcharges rename to material_option_surcharges;

alter table material_option_surcharges
  rename column finish_id to material_option_id;

alter table proof_versions
  rename column finishes to material_options;

alter table proof_version_images
  rename column finish to material_option;

-- Rename RLS policies for consistency (string names; they auto-apply to the
-- renamed table regardless, this is purely cosmetic).
alter policy "finishes: public read"          on material_options          rename to "material_options: public read";
alter policy "finishes: authenticated write"  on material_options          rename to "material_options: authenticated write";
alter policy "finish_surcharges: public read"         on material_option_surcharges rename to "material_option_surcharges: public read";
alter policy "finish_surcharges: authenticated write" on material_option_surcharges rename to "material_option_surcharges: authenticated write";

-- ── 2. Per-material option label ──────────────────────────────────────────────
-- Singular form ("Finish", "Species"). The UI pluralises heuristically for
-- section headers ("Finishes", "Species") and uses it verbatim for singular
-- contexts ("Prices shown for Brushed finish").

alter table materials
  add column option_label text;

update materials set option_label = 'Finish'  where code in ('metal_steel', 'metal_gold');
update materials set option_label = 'Species' where code = 'wood';

-- ── 3. Seed wood species ──────────────────────────────────────────────────────
-- All five species are priced identically with no surcharges, so no rows in
-- material_option_surcharges for wood. Black Walnut arbitrarily marked as
-- is_base (they're all equal; this just chooses the default tab).

insert into material_options (material_id, code, display_name, is_base, sort_order)
select
  m.id,
  v.code,
  v.display_name,
  v.is_base,
  v.sort_order
from materials m
cross join (values
  ('black_walnut',    'Black Walnut',    true,  0),
  ('american_cherry', 'American Cherry', false, 1),
  ('finnish_birch',   'Finnish Birch',   false, 2),
  ('canadian_maple',  'Canadian Maple',  false, 3),
  ('bamboo',          'Bamboo',          false, 4)
) as v(code, display_name, is_base, sort_order)
where m.code = 'wood';

-- ── 4. Rebuild public views ───────────────────────────────────────────────────

drop view if exists public_finishes;
create view public_material_options as
  select id, material_id, code, display_name, is_base, sort_order
  from material_options
  order by sort_order;
grant select on public_material_options to anon, authenticated;

drop view if exists public_finish_surcharges;
create view public_material_option_surcharges as
  select id, material_option_id, currency, quantity, surcharge
  from material_option_surcharges;
grant select on public_material_option_surcharges to anon, authenticated;

-- public_proof_versions: expose material_options (was: finishes) and the new
-- option_label.
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
    m.disclaimer as material_disclaimer,
    m.option_label,
    pv.custom_quote
  from proof_versions pv
  join materials m on m.id = pv.material_id;
grant select on public_proof_versions to anon, authenticated;

-- public_proof_version_images: rename finish → material_option in exposed shape.
drop view if exists public_proof_version_images;
create view public_proof_version_images as
  select id, proof_version_id, image_path, label, sort_order, material_option, original_filename
  from proof_version_images;
grant select on public_proof_version_images to anon, authenticated;

commit;
