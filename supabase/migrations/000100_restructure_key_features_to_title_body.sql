-- Migration 000100: restructure key_features to title + body jsonb
--
-- Supersedes the migration 000099 text[] shape. Each material now
-- carries a curated jsonb array of {title, body} objects, surfaced
-- on the customer About section as a numbered editorial list
-- (01-04) with a bolded title and supporting body line beneath.
--
-- The underlying text[] is dropped wholesale rather than migrated
-- in place; the re-seed content is a full rewrite (new titles and
-- supporting lines per feature) approved by Rob. Single
-- transaction so the view never sits in a broken intermediate
-- state between the column type swap and the content re-seed.

begin;

-- View depends on the column, must drop first.
drop view public_proof_versions;

-- Type swap: text[] to jsonb. Drop + add in one ALTER TABLE so
-- the column is fully replaced atomically.
alter table materials
  drop column key_features,
  add column key_features jsonb null;

-- 19 material re-seeds. Each entry: jsonb array of 4 objects,
-- each object { "title": string, "body": string }. Content
-- verbatim from Rob's approved copy.

update materials set key_features = '[
  {"title": "Rolled stainless steel", "body": "Precision etched from sheet metal with exceptional detail and accuracy."},
  {"title": "Three thicknesses", "body": "300, 500 and 800 micron, each with its own flex and rigidity."},
  {"title": "Custom shaping", "body": "Perimeter can be altered to any shape, included as standard."},
  {"title": "Optional polymer infills", "body": "Any Pantone colour, filling etched recesses for contrast and depth."}
]'::jsonb where code = 'metal_steel';

update materials set key_features = '[
  {"title": "Yellow or rose gold", "body": "Classic finishes applied to stainless steel via autocatalytic plating."},
  {"title": "Three surface finishes", "body": "Natural matte, brushed or mirrored, each with a distinct character."},
  {"title": "Two thicknesses", "body": "Choose the weight and flex that suits the design."},
  {"title": "Optional polymer infills", "body": "Any Pantone colour for a vivid contrast against the polished gold."}
]'::jsonb where code = 'metal_gold';

update materials set key_features = '[
  {"title": "Solid copper", "body": "Warm natural tone with a refined brushed surface finish."},
  {"title": "Three thicknesses", "body": "300, 500 and 800 micron, laser and photochemically milled."},
  {"title": "Intricate cut-throughs", "body": "Remarkable detail in fonts, graphics and decorative perforations."},
  {"title": "Optional polymer infills", "body": "Colour or matt black, each a striking contrast against the copper."}
]'::jsonb where code = 'metal_copper';

update materials set key_features = '[
  {"title": "Darkened steel", "body": "Laser cut and hand brushed for a distinctive deep finish."},
  {"title": "Etched to the core", "body": "Cuts expose the lighter steel beneath for natural contrast."},
  {"title": "Three thicknesses", "body": "300, 500 and 800 micron."},
  {"title": "Custom shaping", "body": "Perimeter can be altered to any shape, included as standard."}
]'::jsonb where code = 'metal_gun_metal';

update materials set key_features = '[
  {"title": "Marine grade stainless steel", "body": "Finished with durable matte black plating."},
  {"title": "Laser etched detail", "body": "Cuts through the coating to reveal the bright steel beneath."},
  {"title": "Three thicknesses", "body": "300, 500 and 800 micron, each with its own flex and rigidity."},
  {"title": "Custom shaping and polymer infills", "body": "Included at no extra charge on every order."}
]'::jsonb where code = 'metal_matte_black';

update materials set key_features = '[
  {"title": "White-coated stainless steel", "body": "Autocatalytic plating gives a durable matte finish over rolled steel."},
  {"title": "Laser etched detail", "body": "Cuts through the coating to expose the bright steel beneath."},
  {"title": "Three thicknesses", "body": "300, 500 and 800 micron, each with its own flex and rigidity."},
  {"title": "Optional polymer infills", "body": "Any Pantone colour, filling the etched recesses for contrast."}
]'::jsonb where code = 'metal_matte_white';

update materials set key_features = '[
  {"title": "Smaller format", "body": "Quirky compact size, keeping the same etched detail as the standard range."},
  {"title": "Three thicknesses", "body": "200, 300 and 500 micron, with spring-back flexibility."},
  {"title": "Custom shaping", "body": "Perimeter can be altered to any shape, included as standard."},
  {"title": "Tarnish resistant", "body": "Designed as a memorable keepsake rather than a standard card."}
]'::jsonb where code = 'metal_mini_steel';

update materials set key_features = '[
  {"title": "Aerospace grade sheet", "body": "Strong and light, with a natural silver-grey surface."},
  {"title": "Exceptionally hard wearing", "body": "Resists scratching and develops subtle character over time."},
  {"title": "Precision etched", "body": "Same fine detail we apply across the metal range."},
  {"title": "Custom shaping", "body": "Perimeter can be altered to any shape, included as standard."}
]'::jsonb where code = 'metal_titanium';

update materials set key_features = '[
  {"title": "Genuine twill weave", "body": "0.8mm carbon fibre, the real thing rather than a facsimile."},
  {"title": "Satin lacquer finish", "body": "Diagonal weave catches the light and conveys technical pedigree."},
  {"title": "Strong and light", "body": "Feather-weight card with remarkable structural integrity."},
  {"title": "Screen printed detail", "body": "Vibrant Pantone colours for striking contrast against the dark weave."}
]'::jsonb where code = 'carbon_fibre';

update materials set key_features = '[
  {"title": "Genuine twill weave", "body": "0.8mm carbon fibre, CNC milled to your exact specifications."},
  {"title": "Custom perimeter shapes", "body": "Any shape you like, without compromising structural integrity."},
  {"title": "Intricate cut-throughs", "body": "Decorative detail that transforms the card into an engineered object."},
  {"title": "Screen printed detail", "body": "Vibrant Pantone colours for striking contrast against the iconic weave."}
]'::jsonb where code = 'carbon_fibre_cnc';

update materials set key_features = '[
  {"title": "Real wood veneer", "body": "3mm triplex stock faced with genuine wood, each grain unique."},
  {"title": "High density core", "body": "Prevents warping and keeps the card flat over time."},
  {"title": "Six species", "body": "Oak, walnut, cherry, birch, maple and bamboo."},
  {"title": "Laser engraved", "body": "CO2 laser etches text and artwork at exceptional resolution."}
]'::jsonb where code = 'wood';

update materials set key_features = '[
  {"title": "Genuine 3mm Perspex", "body": "Laser cut from the authentic brand, not a generic substitute."},
  {"title": "Fluorescent or frosted", "body": "More than seventeen sandblasted colours across two palettes."},
  {"title": "Hand printed detail", "body": "Vegetable-based pigments and metallic inks, applied under heat."},
  {"title": "Custom shaping", "body": "Decorative cut-throughs included at no extra charge."}
]'::jsonb where code = 'acrylic';

update materials set key_features = '[
  {"title": "Recyclable frosted polymer", "body": "Breaks down in landfill within 36 months, no microplastics."},
  {"title": "Hand printed", "body": "Vegetable-based inks applied with precise registration."},
  {"title": "Edge-to-edge printing", "body": "Dual-sided graphics with layered, light-catching effects."},
  {"title": "Metallic and diffraction inks", "body": "Unique visual character beyond standard CMYK."}
]'::jsonb where code = 'plastic_translucent';

update materials set key_features = '[
  {"title": "Tinted gel on polymer", "body": "Translucent colour layer fused to a hand-printed base."},
  {"title": "Nine distinctive hues", "body": "Red, fuchsia, purple, amber, yellow, cyan, evergreen, lime, smoked grey."},
  {"title": "Complementary inks", "body": "Pigment, metallic and diffraction options matched to each base."},
  {"title": "Edge-to-edge printing", "body": "Hand-crafted process prints right up to the card edge."}
]'::jsonb where code = 'plastic_tinted';

update materials set key_features = '[
  {"title": "Solid core polymer", "body": "Rich black or pristine white, colour runs through to the edge."},
  {"title": "760 micron weight", "body": "The thickness and feel of a premium credit card."},
  {"title": "Glossy varnish contrast", "body": "Selective gloss creates striking texture against the matte surface."},
  {"title": "Metallic or diffraction inks", "body": "Extra dimension for logos and detail work."}
]'::jsonb where code = 'plastic_satin';

update materials set key_features = '[
  {"title": "CMYK digital print", "body": "Photography, gradients and richly detailed artwork reproduced faithfully."},
  {"title": "PVC encapsulation", "body": "Print sealed between two crystal clear layers as part of the card structure."},
  {"title": "Gloss or matte finish", "body": "Your choice, in three different thicknesses."},
  {"title": "Sequential numbering", "body": "Optional numbered runs or QR codes for membership applications."}
]'::jsonb where code = 'plastic_full_colour';

update materials set key_features = '[
  {"title": "900gsm Colorplan triplex", "body": "Three layers of luxurious paper fused with a coloured seam."},
  {"title": "Traditional letterpress", "body": "Each ink gently embedded into the surface, tactile to touch."},
  {"title": "Forty paper colours", "body": "Across the three layers, a huge range of combinations."},
  {"title": "Coloured seam", "body": "Visible on the card edge as a distinctive signature of the construction."}
]'::jsonb where code = 'paper_letterpress';

update materials set key_features = '[
  {"title": "900gsm Colorplan triplex", "body": "Three layers of luxurious paper with a metallic foiled edge."},
  {"title": "Traditional letterpress", "body": "Each ink gently embedded into the surface, tactile to touch."},
  {"title": "Forty paper colours", "body": "Across the three layers, a huge range of combinations."},
  {"title": "Edge gilding", "body": "A range of metallic foils chosen to complement your design."}
]'::jsonb where code = 'paper_letterpress_gilded';

update materials set key_features = '[
  {"title": "350gsm ultra white stock", "body": "Thick, clean and versatile as a base card."},
  {"title": "Matt laminate finish", "body": "Protects against fading and gives a soft tactile feel."},
  {"title": "Optional UV spot gloss", "body": "Subtle textural contrast on logos and detail work."},
  {"title": "Optional metallic foiling", "body": "Hand applied to a 400gsm matt laminated upgrade."}
]'::jsonb where code = 'paper_standard';

-- Rebuild view with the re-typed key_features column. Projection
-- preserved verbatim from the 000099 shape.

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
