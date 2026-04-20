-- Migration 000037: gate pricing edits to admins
--
-- Third admin-area pass. Every signed-in designer already reads from the
-- five pricing tables to render proof prices, so SELECT stays open to
-- authenticated. UPDATE is narrowed to admins using the is_admin()
-- helper. Inserts and deletes stay blocked (no policy) — phase 2 and the
-- CSV import flow will open those up when needed.
--
-- One exception: add_on_prices needs INSERT for admins, because the
-- admin Pricing UI seeds rows for add-ons that ship with no prices
-- (metal_finish_upgrade, letterpress_gilding, carbon_cnc). Without that
-- seed path those add-ons can't function.

begin;

alter table materials          enable row level security;
alter table material_variants  enable row level security;
alter table price_tiers        enable row level security;
alter table add_ons            enable row level security;
alter table add_on_prices      enable row level security;

-- ── SELECT: all authenticated users ──────────────────────────────────────────

create policy "materials: authenticated read"
  on materials for select to authenticated using (true);

create policy "material_variants: authenticated read"
  on material_variants for select to authenticated using (true);

create policy "price_tiers: authenticated read"
  on price_tiers for select to authenticated using (true);

create policy "add_ons: authenticated read"
  on add_ons for select to authenticated using (true);

create policy "add_on_prices: authenticated read"
  on add_on_prices for select to authenticated using (true);

-- ── UPDATE: admin only ───────────────────────────────────────────────────────

create policy "materials: admin update"
  on materials for update to authenticated using (is_admin());

create policy "material_variants: admin update"
  on material_variants for update to authenticated using (is_admin());

create policy "price_tiers: admin update"
  on price_tiers for update to authenticated using (is_admin());

create policy "add_ons: admin update"
  on add_ons for update to authenticated using (is_admin());

create policy "add_on_prices: admin update"
  on add_on_prices for update to authenticated using (is_admin());

-- ── INSERT on add_on_prices: admin only (seed flow) ──────────────────────────

create policy "add_on_prices: admin insert"
  on add_on_prices for insert to authenticated
  with check (is_admin());

commit;
