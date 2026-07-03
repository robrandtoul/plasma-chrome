-- 000300: Rose Gold Metal as a first-class material — a full server-side clone
-- of Gold Metal (same pricing, thicknesses, finishes, surcharges).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Why now: rose gold has always been sold by picking "Gold Metal" in the
-- version form (identical price list, thicknesses and Natural/Brushed/Mirror
-- finishes), with the artwork carrying the colour. The open-spec checkout
-- (000298/000299) surfaces the material identity to the customer — the Stripe
-- product label, the thickness chooser, and the per-material finish PHOTOS —
-- so rose gold needs its own catalogue row for the right photos and labels to
-- appear. Copper is NOT rose gold: it is a separate always-brushed product and
-- is untouched here (Rob, 2026-07-03).
--
-- Everything is cloned live-row → live-row with INSERT…SELECT (no hand-typed
-- figures), keyed by codes so a replay is a no-op:
--   * materials        — one row, code metal_rose_gold, sort_order 25 (between
--                        gold 20 and copper 30). Description/key features are
--                        cloned verbatim (gold's copy already reads "classic
--                        yellow gold or rose gold"); icon_url is NOT cloned
--                        (gold's icon is yellow — Rob uploads a rose one).
--   * material_variants — 300/500/800 micron incl. per-card weight_grams and
--                        the gold Xero item codes (rose gold has always been
--                        invoiced on gold's items; unchanged behaviour).
--   * price_tiers      — all ~360 rows across GBP/EUR/USD.
--   * material_options — Natural (base) / Brushed / Mirror incl. their Xero
--                        item codes; photo_url NOT cloned (rose gold gets its
--                        own studio photos via Admin → Materials).
--   * material_option_surcharges — the 240 Brushed/Mirror surcharge rows.
--
-- New ROWS only — no new tables/views/functions, so no grant or RLS work.
-- Published + active immediately, matching gold, so it appears in the version
-- form, the quote compiler, the customer pricing card, and (having cloned
-- gold's lead times) the marketing /turnaround-times page. The marketing
-- price-list script is untouched: it renders only its 16 config-pinned tables.

-- 1. The material.
insert into proofs.materials (
  code, display_name, category, sort_order, is_active, is_published,
  variant_type, multi_variant,
  split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd,
  notes, disclaimer, requires_ink_names, option_label, description, icon_url,
  display_quantities, quote_min_quantity, quote_max_quantity, key_features,
  supports_personalisation, lead_time_min_days, lead_time_max_days, lead_time_updated_at,
  production_route, outsourced_product_type, outsourced_supplier_ids
)
select
  'metal_rose_gold', 'Rose Gold Metal', g.category, 25, g.is_active, g.is_published,
  g.variant_type, g.multi_variant,
  g.split_name_surcharge_gbp, g.split_name_surcharge_eur, g.split_name_surcharge_usd,
  g.notes, g.disclaimer, g.requires_ink_names, g.option_label, g.description, null,
  g.display_quantities, g.quote_min_quantity, g.quote_max_quantity, g.key_features,
  g.supports_personalisation, g.lead_time_min_days, g.lead_time_max_days, g.lead_time_updated_at,
  g.production_route, g.outsourced_product_type, g.outsourced_supplier_ids
from proofs.materials g
where g.code = 'metal_gold'
  and not exists (select 1 from proofs.materials where code = 'metal_rose_gold');

-- 2. The three thickness variants (weights + Xero item codes ride along).
insert into proofs.material_variants (
  material_id, code, display_name, variant_type, thickness_microns, ink_count,
  finish_code, sort_order, is_active, weight_grams, xero_item_code
)
select
  rg.id, v.code, v.display_name, v.variant_type, v.thickness_microns, v.ink_count,
  v.finish_code, v.sort_order, v.is_active, v.weight_grams, v.xero_item_code
from proofs.material_variants v
join proofs.materials g on g.id = v.material_id and g.code = 'metal_gold'
join proofs.materials rg on rg.code = 'metal_rose_gold'
where not exists (
  select 1 from proofs.material_variants x
  where x.material_id = rg.id and x.code = v.code
);

-- 3. Every price tier, remapped old-variant → new-variant by variant code.
insert into proofs.price_tiers (material_variant_id, currency, quantity, total_price, unit_price)
select nv.id, t.currency, t.quantity, t.total_price, t.unit_price
from proofs.price_tiers t
join proofs.material_variants gv on gv.id = t.material_variant_id
join proofs.materials g on g.id = gv.material_id and g.code = 'metal_gold'
join proofs.materials rg on rg.code = 'metal_rose_gold'
join proofs.material_variants nv on nv.material_id = rg.id and nv.code = gv.code
where not exists (
  select 1 from proofs.price_tiers x
  where x.material_variant_id = nv.id and x.currency = t.currency and x.quantity = t.quantity
);

-- 4. The finish options (photo_url deliberately left null — Rob uploads rose
--    gold's own Natural/Brushed/Mirror photos in Admin → Materials).
insert into proofs.material_options (material_id, code, display_name, is_base, sort_order, xero_item_code)
select rg.id, o.code, o.display_name, o.is_base, o.sort_order, o.xero_item_code
from proofs.material_options o
join proofs.materials g on g.id = o.material_id and g.code = 'metal_gold'
join proofs.materials rg on rg.code = 'metal_rose_gold'
where not exists (
  select 1 from proofs.material_options x
  where x.material_id = rg.id and x.code = o.code
);

-- 5. The Brushed/Mirror surcharge schedules, remapped by option code.
insert into proofs.material_option_surcharges (material_option_id, currency, quantity, surcharge)
select no_.id, s.currency, s.quantity, s.surcharge
from proofs.material_option_surcharges s
join proofs.material_options go_ on go_.id = s.material_option_id
join proofs.materials g on g.id = go_.material_id and g.code = 'metal_gold'
join proofs.materials rg on rg.code = 'metal_rose_gold'
join proofs.material_options no_ on no_.material_id = rg.id and no_.code = go_.code
where not exists (
  select 1 from proofs.material_option_surcharges x
  where x.material_option_id = no_.id and x.currency = s.currency and x.quantity = s.quantity
);
