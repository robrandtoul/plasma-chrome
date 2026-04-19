-- Migration 000009: rebuild pricing schema
--
-- Replaces the old single `pricing_tables` (migration 000005) with a five-table model:
--   materials           — one row per product family (Steel, Gold, Wood, …)
--   material_variants   — thickness / ink-count / finish per material
--   price_tiers         — (variant, currency, quantity) → total + unit price
--   add_ons             — catalogue of optional extras
--   add_on_prices       — (add-on, currency, quantity) surcharges
--
-- All GBP prices are VAT-inclusive (matches Xero rule). EUR and USD are VAT-free.
-- Quantity between listed tiers is not supported; the UI constrains picks to existing tier values.

begin;

-- 1. Drop the old table (empty, so clean drop is safe).
drop table if exists pricing_tables cascade;

-- 2. Materials catalogue
create table materials (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  category text not null
    check (category in ('metal','plastic','paper','carbon_fibre','wood','acrylic')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  -- Split-name tooling surcharges per extra name beyond the first (per CLAUDE.md pricing rules).
  split_name_surcharge_gbp numeric(10,2),
  split_name_surcharge_eur numeric(10,2),
  split_name_surcharge_usd numeric(10,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Variants (thickness / ink-count / finish) per material
create table material_variants (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  code text not null,
  display_name text not null,
  variant_type text not null
    check (variant_type in ('thickness','ink_count','finish','default')),
  thickness_microns int,
  ink_count int,
  finish_code text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  unique (material_id, code)
);

-- 4. Quantity-tiered prices per variant, per currency
create table price_tiers (
  id uuid primary key default gen_random_uuid(),
  material_variant_id uuid not null references material_variants(id) on delete cascade,
  currency char(3) not null check (currency in ('GBP','EUR','USD')),
  quantity int not null check (quantity > 0),
  total_price numeric(10,2) not null check (total_price >= 0),
  unit_price numeric(10,4) not null check (unit_price >= 0),
  unique (material_variant_id, currency, quantity)
);
create index price_tiers_variant_currency_qty_idx
  on price_tiers (material_variant_id, currency, quantity);

-- 5. Add-ons catalogue
create table add_ons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  pricing_model text not null
    check (pricing_model in ('per_quantity_tier','flat','custom_quote')),
  -- If populated, this add-on is only available for these material codes; empty = all materials.
  applies_to_material_codes text[] not null default '{}',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 6. Add-on pricing rows
create table add_on_prices (
  id uuid primary key default gen_random_uuid(),
  add_on_id uuid not null references add_ons(id) on delete cascade,
  currency char(3) not null check (currency in ('GBP','EUR','USD')),
  -- quantity IS NULL for flat add-ons; populated for per_quantity_tier add-ons.
  quantity int,
  surcharge numeric(10,2) not null check (surcharge >= 0),
  unique (add_on_id, currency, quantity)
);
create index add_on_prices_addon_currency_qty_idx
  on add_on_prices (add_on_id, currency, quantity);

-- 7. Materials catalogue rows
insert into materials (code, display_name, category, sort_order,
  split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd) values
  ('metal_steel',         'Steel',              'metal',        10, 39.00, 39.00, 49.00),
  ('metal_gold',          'Gold',               'metal',        20, 39.00, 39.00, 49.00),
  ('metal_copper',        'Copper',             'metal',        30, 39.00, 39.00, 49.00),
  ('metal_gun_metal',     'Gun Metal',          'metal',        40, 39.00, 39.00, 49.00),
  ('metal_matte_black',   'Matte Black',        'metal',        50, 39.00, 39.00, 49.00),
  ('metal_matte_white',   'Matte White',        'metal',        60, 39.00, 39.00, 49.00),
  ('metal_mini_steel',    'Mini Steel',         'metal',        70, 39.00, 39.00, 49.00),
  ('metal_titanium',      'Titanium',           'metal',        80, 39.00, 39.00, 49.00),
  ('carbon_fibre',        'Carbon Fibre',       'carbon_fibre', 90, null,  null,  null),
  ('wood',                'Wood',               'wood',        100, null,  null,  null),
  ('acrylic',             'Acrylic (Perspex)',  'acrylic',     110, null,  null,  null),
  ('plastic_translucent', 'Translucent Plastic','plastic',     120, 25.00, 39.00, 39.00),
  ('plastic_tinted',      'Tinted Plastic',     'plastic',     130, 25.00, 39.00, 39.00),
  ('plastic_satin',       'Satin Plastic',      'plastic',     140, 25.00, 39.00, 39.00),
  ('plastic_full_colour', 'Full Colour Plastic','plastic',     150, 15.00, 25.00, 25.00),
  ('paper_letterpress',   'Letterpress',        'paper',       160, 25.00, 39.00, 39.00),
  ('paper_standard',      'Standard Paper',     'paper',       170, null,  null,  null);

-- 8. Variants
-- Helper: insert variants keyed by the material code we just seeded.
insert into material_variants (material_id, code, display_name, variant_type, thickness_microns, sort_order)
select m.id, v.code, v.display_name, 'thickness', v.thickness_microns, v.sort_order
from materials m
join (values
  -- Standard 3-thickness metals
  ('metal_steel',       '300um',  '300 micron',  300,  10),
  ('metal_steel',       '500um',  '500 micron',  500,  20),
  ('metal_steel',       '800um',  '800 micron',  800,  30),
  ('metal_gold',        '300um',  '300 micron',  300,  10),
  ('metal_gold',        '500um',  '500 micron',  500,  20),
  ('metal_gold',        '800um',  '800 micron',  800,  30),
  ('metal_copper',      '300um',  '300 micron',  300,  10),
  ('metal_copper',      '500um',  '500 micron',  500,  20),
  ('metal_copper',      '800um',  '800 micron',  800,  30),
  ('metal_gun_metal',   '300um',  '300 micron',  300,  10),
  ('metal_gun_metal',   '500um',  '500 micron',  500,  20),
  ('metal_gun_metal',   '800um',  '800 micron',  800,  30),
  ('metal_matte_black', '300um',  '300 micron',  300,  10),
  ('metal_matte_black', '500um',  '500 micron',  500,  20),
  ('metal_matte_black', '800um',  '800 micron',  800,  30),
  ('metal_matte_white', '300um',  '300 micron',  300,  10),
  ('metal_matte_white', '500um',  '500 micron',  500,  20),
  ('metal_matte_white', '800um',  '800 micron',  800,  30),
  -- Mini steel uses 200 / 300 / 500
  ('metal_mini_steel',  '200um',  '200 micron',  200,  10),
  ('metal_mini_steel',  '300um',  '300 micron',  300,  20),
  ('metal_mini_steel',  '500um',  '500 micron',  500,  30),
  -- Titanium single thickness
  ('metal_titanium',    '1000um', '1000 micron', 1000, 10),
  -- Plastic full colour thicknesses
  ('plastic_full_colour', '420um', '420 micron', 420, 10),
  ('plastic_full_colour', '680um', '680 micron', 680, 20),
  ('plastic_full_colour', '760um', '760 micron', 760, 30)
) as v(material_code, code, display_name, thickness_microns, sort_order)
  on v.material_code = m.code;

-- Ink-count variants for plastic and letterpress
insert into material_variants (material_id, code, display_name, variant_type, ink_count, sort_order)
select m.id, v.code, v.display_name, 'ink_count', v.ink_count, v.sort_order
from materials m
join (values
  ('plastic_translucent', '1_ink',  '1 Ink',  1, 10),
  ('plastic_translucent', '2_ink',  '2 Inks', 2, 20),
  ('plastic_translucent', '3_ink',  '3 Inks', 3, 30),
  ('plastic_translucent', '4_ink',  '4 Inks', 4, 40),
  ('plastic_tinted',      '1_ink',  '1 Ink',  1, 10),
  ('plastic_tinted',      '2_ink',  '2 Inks', 2, 20),
  ('plastic_tinted',      '3_ink',  '3 Inks', 3, 30),
  ('plastic_tinted',      '4_ink',  '4 Inks', 4, 40),
  ('plastic_satin',       '1_ink',  '1 Ink',  1, 10),
  ('plastic_satin',       '2_ink',  '2 Inks', 2, 20),
  ('plastic_satin',       '3_ink',  '3 Inks', 3, 30),
  ('plastic_satin',       '4_ink',  '4 Inks', 4, 40),
  ('paper_letterpress',   '1_ink',  '1 Ink',  1, 10),
  ('paper_letterpress',   '2_ink',  '2 Inks', 2, 20),
  ('paper_letterpress',   '3_ink',  '3 Inks', 3, 30),
  ('paper_letterpress',   '4_ink',  '4 Inks', 4, 40)
) as v(material_code, code, display_name, ink_count, sort_order)
  on v.material_code = m.code;

-- Finish variants for Standard Paper
insert into material_variants (material_id, code, display_name, variant_type, finish_code, sort_order)
select m.id, v.code, v.display_name, 'finish', v.finish_code, v.sort_order
from materials m
join (values
  ('paper_standard', 'standard', 'Standard',    'standard', 10),
  ('paper_standard', 'uv_spot',  'With UV Spot','uv_spot',  20),
  ('paper_standard', 'foiling',  'With Foiling','foiling',  30)
) as v(material_code, code, display_name, finish_code, sort_order)
  on v.material_code = m.code;

-- Default variants for materials with no sub-dimensions
insert into material_variants (material_id, code, display_name, variant_type, sort_order)
select m.id, 'default', m.display_name, 'default', 10
from materials m
where m.code in ('carbon_fibre','wood','acrylic');

-- 9. Add-ons catalogue
insert into add_ons (code, display_name, pricing_model, applies_to_material_codes, notes) values
  ('metal_finish_upgrade', 'Mirror / Brushed Finish Upgrade', 'per_quantity_tier',
    array['metal_steel','metal_gold'],
    'Optional finish upgrade available on Steel and Gold. Surcharge scales with quantity.'),
  ('letterpress_gilding',  'Edge Gilding',                     'per_quantity_tier',
    array['paper_letterpress'],
    'Optional edge gilding on letterpress cards. Surcharge scales with quantity.'),
  ('carbon_cnc',           'CNC Cutting',                      'per_quantity_tier',
    array['carbon_fibre'],
    'Optional CNC cutting for carbon fibre cards. Surcharge scales with quantity.');

commit;
