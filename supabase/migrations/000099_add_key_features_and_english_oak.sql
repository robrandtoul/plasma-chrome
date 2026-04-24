-- Migration 000099: key features on materials + English Oak species
--
-- Two parallel threads in one migration:
--
--   1. Add materials.key_features text[] null — a curated list
--      of short one-liners per material surfaced on the
--      customer proof page's About section as a bulleted list
--      below the narrative paragraph. Nullable so materials
--      without curated features fall back to hiding the block
--      cleanly; seeded here verbatim for all 19 seeded
--      materials as approved by Rob.
--
--   2. English Oak as a sixth wood species. Wood uses the
--      material_options catalogue for its species dimension;
--      every species is priced identically so the new row
--      needs no material_option_surcharges entries — oak
--      inherits the wood material's single default variant's
--      price tiers via the existing catalogue-rate model.
--      sort_order 5 (after Bamboo at 4). The wood key_features
--      copy seeded in this migration references "six distinct
--      species including oak", so the option addition and
--      the content addition land together.
--
-- View rebuild at the end exposes m.key_features on
-- public_proof_versions, preserving the 000096 projection
-- verbatim. All steps inside a single transaction so the view
-- never sits in a broken intermediate state.

begin;

-- 1. Column addition

alter table materials add column key_features text[] null;

-- 2. Seed key_features per material (19 rows, 4 features each)

update materials set key_features = array[
  'Three thickness options (300, 500, 800 micron)',
  'Precision etched from rolled stainless steel',
  'Custom perimeter shaping included',
  'Optional Pantone polymer infills for colour detail'
]::text[] where code = 'metal_steel';

update materials set key_features = array[
  'Classic yellow gold or rose gold finishes',
  'Natural matte, brushed or mirrored surface options',
  'Two thicknesses with intricate etched detail',
  'Optional polymer infills for contrasting colour'
]::text[] where code = 'metal_gold';

update materials set key_features = array[
  'Warm solid copper with brushed surface finish',
  'Three thicknesses, photochemical and laser milled',
  'Intricate cut-throughs and detailed etching',
  'Optional polymer infills in colour or matt black'
]::text[] where code = 'metal_copper';

update materials set key_features = array[
  'Laser cut from darkened steel, hand brushed',
  'Etched through to reveal the lighter core',
  'Three thickness options (300, 500, 800 micron)',
  'Custom perimeter shaping included'
]::text[] where code = 'metal_gun_metal';

update materials set key_features = array[
  'Marine grade stainless steel with matte black plating',
  'Laser etched to expose the bright steel beneath',
  'Three thickness options (300, 500, 800 micron)',
  'Custom shaping and polymer infills included'
]::text[] where code = 'metal_matte_black';

update materials set key_features = array[
  'Stainless steel finished with durable white coating',
  'Laser etched for crisp contrast against bright steel',
  'Three thickness options (300, 500, 800 micron)',
  'Optional polymer infills in Pantone colours'
]::text[] where code = 'metal_matte_white';

update materials set key_features = array[
  'Smaller format with spring-back flexibility',
  'Three thickness options (200, 300, 500 micron)',
  'Custom perimeter shapes included at no extra charge',
  'Resists tarnishing, designed as a memorable keepsake'
]::text[] where code = 'metal_mini_steel';

update materials set key_features = array[
  'Aerospace grade titanium sheet',
  'Natural silver-grey surface, exceptionally hard wearing',
  'Develops subtle character over time',
  'Custom perimeter shaping included'
]::text[] where code = 'metal_titanium';

update materials set key_features = array[
  'Genuine 0.8mm twill weave carbon fibre',
  'Satin lacquer finish over diagonal weave',
  'Remarkable strength at feather light weight',
  'Screen printed in vibrant Pantone colours'
]::text[] where code = 'carbon_fibre';

update materials set key_features = array[
  'CNC milled to your exact specifications',
  'Custom perimeter shapes and intricate cut-throughs',
  'Genuine 0.8mm twill weave with satin lacquer',
  'Screen printed in vibrant Pantone colours'
]::text[] where code = 'carbon_fibre_cnc';

update materials set key_features = array[
  '3mm triplex with real wood veneer face',
  'High density core prevents warping',
  'Six distinct species including oak, walnut and cherry',
  'CO2 laser engraved at exceptional resolution'
]::text[] where code = 'wood';

update materials set key_features = array[
  'Laser cut from genuine 3mm Perspex',
  'Fluorescent or frosted palette (17+ colours)',
  'Hand printed with vegetable based pigments',
  'Custom shapes and decorative cut-throughs included'
]::text[] where code = 'acrylic';

update materials set key_features = array[
  'Fully recyclable frosted polymer',
  'Breaks down in landfill within 36 months',
  'Edge to edge, dual sided printing',
  'Metallic and diffraction ink options'
]::text[] where code = 'plastic_translucent';

update materials set key_features = array[
  'Tinted translucent gel fused to printed polymer',
  'Nine colours including fuchsia, amber, smoked grey',
  'Complementary metallic and diffraction inks',
  'Graphics print right to the edge'
]::text[] where code = 'plastic_tinted';

update materials set key_features = array[
  'Solid core polymer in rich black or pristine white',
  '760 micron weight of a premium credit card',
  'Colour matched core runs through to the edge',
  'Selective glossy varnish for textural contrast'
]::text[] where code = 'plastic_satin';

update materials set key_features = array[
  'Digital CMYK print sealed between crystal clear PVC',
  'Print becomes part of the card''s structure',
  'Three thicknesses, gloss or matte finish',
  'Optional sequential numbering or QR codes'
]::text[] where code = 'plastic_full_colour';

update materials set key_features = array[
  'Three layers of 900gsm Colorplan paper',
  'Traditional letterpress deboss, tactile to touch',
  'Forty paper colours across the three layers',
  'Coloured seam visible on the card edge'
]::text[] where code = 'paper_letterpress';

update materials set key_features = array[
  'Three layers of 900gsm Colorplan paper with foiled edge',
  'Traditional letterpress deboss, tactile to touch',
  'Forty paper colours across the three layers',
  'Edge gilding in a range of metallic foils'
]::text[] where code = 'paper_letterpress_gilded';

update materials set key_features = array[
  '350gsm ultra white stock with matt laminate',
  'Protects against fading, soft tactile feel',
  'Optional UV spot gloss for highlight detail',
  'Optional hand applied metallic foiling'
]::text[] where code = 'paper_standard';

-- 3. English Oak as sixth wood species

insert into material_options (material_id, code, display_name, is_base, sort_order)
select m.id, 'english_oak', 'English Oak', false, 5
from materials m where m.code = 'wood';

-- 4. View rebuild — append m.key_features to the 000096 projection verbatim

drop view public_proof_versions;

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
    m.key_features
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
