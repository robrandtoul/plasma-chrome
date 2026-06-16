-- 000233: per-species Xero item codes for wood (material_options).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- WHY: 000232 mapped wood to a single Xero item, 015 ("Wood cards (3mm thick)
-- - Mixed"), on material_variants. But Xero actually carries a distinct item
-- per wood species (Black Walnut 0151, American Cherry 0152, Bamboo 0153,
-- Finnish Birch 0154, Canadian Maple 0155). The species the customer approved
-- is recorded on the proof version's material_options array (e.g. ['bamboo']),
-- so the invoice can name the exact species rather than the generic "Mixed".
--
-- HOW: a per-option Xero code on material_options. The stripe-webhook prefers
-- this code over the variant's generic code when the order's current version
-- pins exactly one option that carries a code; otherwise it falls back to the
-- variant code (wood "Mixed" 015). Generic by design — only wood species carry
-- a code today, so non-wood options (metal finishes, letterpress colours) stay
-- null and never override.
--
-- Codes reconciled against the live Xero InventoryItems export (2026-06-15):
-- every code below was confirmed against PlasmaDesign Ltd's item list by name.
-- English Oak (english_oak) has no Xero item yet, so it is left null and falls
-- back to 015 ("Mixed"); set it here if/when an item is created.

-- ── 1. material_options.xero_item_code ───────────────────────────────────
-- The Xero ItemCode an order invoices as when this option is the single
-- chosen option. Nullable: an option with no code falls back to the variant's
-- code, so nothing breaks. Designer/service-role only — NOT exposed on
-- public_material_options or any anon RPC (this migration only ALTERs the base
-- table, leaving the view's column list untouched). material_options carries
-- SELECT-only to authenticated (000176); the webhook reads it as service role.
alter table proofs.material_options
  add column if not exists xero_item_code text;

-- ── 2. pre-fill the wood species → Xero item mapping ─────────────────────
-- Idempotent: re-running sets the same values. Scoped to the wood material so
-- an option code that happens to repeat under another material is untouched.
with map(option_code, item_code) as (values
  ('black_walnut',   '0151'),
  ('american_cherry','0152'),
  ('bamboo',         '0153'),
  ('finnish_birch',  '0154'),
  ('canadian_maple', '0155')
)
update proofs.material_options mo
   set xero_item_code = map.item_code
  from map
  join proofs.materials m on m.code = 'wood'
 where mo.material_id = m.id
   and mo.code = map.option_code;
