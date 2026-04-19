-- Migration 000020: per-finish pricing for Steel and Gold
--
-- Adds two new tables:
--   finishes          — Natural / Brushed / Mirror options per material
--   finish_surcharges — per-(finish, currency, quantity) surcharge on top of base price
--
-- Alters existing tables:
--   proof_versions       — adds finishes text[]  (which finishes this version offers)
--   proof_version_images — adds finish text       (which finish each image belongs to)
--
-- Updates public views to expose the new columns.
-- Seeds finishes and surcharges for metal_steel and metal_gold.

begin;

-- ── 1. finishes ───────────────────────────────────────────────────────────────

create table finishes (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  code        text not null,
  display_name text not null,
  is_base     boolean not null default false,  -- true = Natural (no surcharge)
  sort_order  int not null default 0,
  unique (material_id, code)
);

-- ── 2. finish_surcharges ──────────────────────────────────────────────────────

create table finish_surcharges (
  id         uuid primary key default gen_random_uuid(),
  finish_id  uuid not null references finishes(id) on delete cascade,
  currency   char(3) not null check (currency in ('GBP','EUR','USD')),
  quantity   int not null check (quantity > 0),
  surcharge  numeric(10,2) not null check (surcharge >= 0),
  unique (finish_id, currency, quantity)
);

-- ── 3. RLS ────────────────────────────────────────────────────────────────────

alter table finishes enable row level security;

create policy "finishes: public read"
  on finishes for select using (true);

create policy "finishes: authenticated write"
  on finishes for all to authenticated using (true) with check (true);

alter table finish_surcharges enable row level security;

create policy "finish_surcharges: public read"
  on finish_surcharges for select using (true);

create policy "finish_surcharges: authenticated write"
  on finish_surcharges for all to authenticated using (true) with check (true);

-- ── 4. Extend proof_versions ──────────────────────────────────────────────────

alter table proof_versions
  add column finishes text[] not null default '{}';

-- ── 5. Extend proof_version_images ───────────────────────────────────────────

alter table proof_version_images
  add column finish text;

-- ── 6. Public views ───────────────────────────────────────────────────────────

create view public_finishes as
  select id, material_id, code, display_name, is_base, sort_order
  from finishes
  order by sort_order;

grant select on public_finishes to anon, authenticated;

create view public_finish_surcharges as
  select id, finish_id, currency, quantity, surcharge
  from finish_surcharges;

grant select on public_finish_surcharges to anon, authenticated;

-- Update public_proof_versions to include finishes column
-- (drop first — create or replace can't reorder/add columns)

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
    pv.finishes,
    m.featured_quantities,
    m.disclaimer as material_disclaimer
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

-- Update public_proof_version_images to include finish column

drop view if exists public_proof_version_images;

create view public_proof_version_images as
  select id, proof_version_id, image_path, label, sort_order, finish
  from proof_version_images;

grant select on public_proof_version_images to anon, authenticated;

-- ── 7. Seed finishes for Steel and Gold ──────────────────────────────────────

insert into finishes (material_id, code, display_name, is_base, sort_order)
select m.id, v.code, v.display_name, v.is_base, v.sort_order
from materials m
cross join (values
  ('natural', 'Natural', true,  0),
  ('brushed', 'Brushed', false, 1),
  ('mirror',  'Mirror',  false, 2)
) as v(code, display_name, is_base, sort_order)
where m.code in ('metal_steel', 'metal_gold');

-- ── 8. Seed finish_surcharges for Brushed and Mirror ─────────────────────────
--
-- Same surcharge schedule for both finishes, both materials, all three currencies.
-- GBP values are VAT-inclusive (matching all GBP prices in this system).
-- Sourced from product-specific Steel and Gold pricing spreadsheets in Dropbox.

insert into finish_surcharges (finish_id, currency, quantity, surcharge)
select f.id, curr.currency, tier.quantity, tier.surcharge
from finishes f
join materials m on m.id = f.material_id
cross join (values ('GBP'::char(3)), ('EUR'::char(3)), ('USD'::char(3))) as curr(currency)
cross join (values
  (  50,  30.00),
  (  75,  40.00),
  ( 100,  50.00),
  ( 125,  60.00),
  ( 150,  70.00),
  ( 175,  80.00),
  ( 200,  90.00),
  ( 225, 100.00),
  ( 250, 110.00),
  ( 275, 119.00),
  ( 300, 128.00),
  ( 325, 137.00),
  ( 350, 146.00),
  ( 375, 155.00),
  ( 400, 164.00),
  ( 425, 173.00),
  ( 450, 182.00),
  ( 475, 191.00),
  ( 500, 200.00),
  ( 525, 210.00),
  ( 550, 220.00),
  ( 575, 230.00),
  ( 600, 240.00),
  ( 625, 250.00),
  ( 650, 260.00),
  ( 675, 270.00),
  ( 700, 280.00),
  ( 725, 290.00),
  ( 750, 300.00),
  ( 775, 310.00),
  ( 800, 320.00),
  ( 825, 330.00),
  ( 850, 340.00),
  ( 875, 350.00),
  ( 900, 360.00),
  ( 925, 370.00),
  ( 950, 380.00),
  ( 975, 390.00),
  (1000, 400.00)
) as tier(quantity, surcharge)
where m.code in ('metal_steel', 'metal_gold')
  and f.code in ('brushed', 'mirror');

commit;
