-- 000232: itemised Xero invoices — per-variant Xero item codes + order price
-- breakdown.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- WHY: the Stripe→Xero sync (stripe-webhook → createSalesInvoice) currently
-- books a single summary line ("Order <ref>") to the Sales account. Rob's
-- bookkeeping wants the same line split Xero uses everywhere else: the product
-- as its own inventory item (so per-product revenue reports work), the
-- split-name tooling as item 020, and shipping as 050 (international) / 052
-- (domestic UK). To do that the invoice writer needs (a) which Xero item each
-- card variant maps to, and (b) the price split that produced the total.
--
-- Two additive, low-risk changes (all nullable / backfill-only), then a
-- pre-filled mapping reconciled against the live Xero InventoryItems export
-- (2026-06-15). Personalisation folds into the product line (Rob's decision),
-- so there is no separate personalisation item.

-- ── 1. material_variants.xero_item_code ──────────────────────────────────
-- The Xero ItemCode this card variant invoices as. Nullable: an unmapped
-- variant (or a future product before its item exists) falls back to the
-- single summary line, so nothing breaks. Designer-only — NOT exposed on any
-- public_* view or anon RPC. material_variants already carries authenticated
-- CRUD (000176), so no grant change is needed.
alter table proofs.material_variants
  add column if not exists xero_item_code text;

-- ── 2. orders price breakdown ────────────────────────────────────────────
-- create-checkout-session stamps these when it prices the order, so the
-- webhook can rebuild the invoice lines without re-pricing (and cross-check
-- their sum against the Stripe charge). All nullable: a custom-quote order
-- leaves the component columns null and keeps custom_quote_total (000229);
-- a legacy order placed before this migration has them null too and falls
-- back to the single summary line. amount_cards already folds in
-- personalisation at invoice time, but the two are stored separately so the
-- split stays auditable.
alter table proofs.orders
  add column if not exists amount_cards          numeric(10,2) check (amount_cards is null or amount_cards >= 0),
  add column if not exists amount_tooling        numeric(10,2) check (amount_tooling is null or amount_tooling >= 0),
  add column if not exists amount_personalisation numeric(10,2) check (amount_personalisation is null or amount_personalisation >= 0),
  add column if not exists amount_shipping       numeric(10,2) check (amount_shipping is null or amount_shipping >= 0);

-- ── 3. pre-fill the variant → Xero item mapping ──────────────────────────
-- Reconciled against InventoryItems20260615.csv. Idempotent: re-running sets
-- the same values. Three shapes:
--   * thickness-keyed  — metals + full-colour plastic, one item per thickness
--   * finish-keyed     — standard paper, one item per finish
--   * whole-material   — default + ink-count materials, all variants one item
--     (Xero has a single item for letterpress / translucent etc. regardless
--      of ink count)

-- 3a. thickness-keyed
with map(material_code, thickness_microns, item_code) as (values
  ('metal_steel',       300, '013'),  ('metal_steel',       500, '0144'),  ('metal_steel',       800, '01442'),
  ('metal_gold',        300, '0146'), ('metal_gold',        500, '0147'),  ('metal_gold',        800, '01475'),
  ('metal_gun_metal',   300, '017'),  ('metal_gun_metal',   500, '0171'),  ('metal_gun_metal',   800, '0172'),
  ('metal_copper',      300, '0173'), ('metal_copper',      500, '0174'),  ('metal_copper',      800, '0175'),
  ('metal_matte_black', 300, '0131'), ('metal_matte_black', 500, '0143'),  ('metal_matte_black', 800, '01441'),
  ('metal_matte_white', 300, '0135'), ('metal_matte_white', 500, '01435'), ('metal_matte_white', 800, '01445'),
  ('metal_mini_steel',  200, '0191'), ('metal_mini_steel',  300, '0192'),  ('metal_mini_steel',  500, '0193'),
  ('metal_titanium',   1000, '0176'),
  ('plastic_full_colour', 420, '003'), ('plastic_full_colour', 680, '0031'), ('plastic_full_colour', 760, '0032')
)
update proofs.material_variants v
   set xero_item_code = map.item_code
  from map
  join proofs.materials m on m.code = map.material_code
 where v.material_id = m.id
   and v.thickness_microns = map.thickness_microns;

-- 3b. finish-keyed (standard paper)
with map(material_code, finish_code, item_code) as (values
  ('paper_standard', 'standard', '011'),
  ('paper_standard', 'uv_spot',  '0112'),
  ('paper_standard', 'foiling',  '0111')
)
update proofs.material_variants v
   set xero_item_code = map.item_code
  from map
  join proofs.materials m on m.code = map.material_code
 where v.material_id = m.id
   and v.finish_code = map.finish_code;

-- 3c. whole-material (default + ink-count collapse). Acrylic uses 004
-- ("Perspex cards (3mm thick)"); 016 ("Perspex cards (3mm)") is the
-- duplicate and is left unused — flip it in the admin page if preferred.
with map(material_code, item_code) as (values
  ('acrylic',                  '004'),
  ('carbon_fibre',             '0704'),
  ('carbon_fibre_cnc',         '0705'),
  ('wood',                     '015'),
  ('paper_letterpress',        '010'),
  ('paper_letterpress_gilded', '0102'),
  ('plastic_satin',            '002'),
  ('plastic_tinted',           '0015'),
  ('plastic_translucent',      '001')
)
update proofs.material_variants v
   set xero_item_code = map.item_code
  from map
  join proofs.materials m on m.code = map.material_code
 where v.material_id = m.id;
