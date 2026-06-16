-- 000239: capture the chosen metal finish on an order.
--
-- ⚠ TARGET: the merged stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / MCP apply_migration.
--
-- Metal (and any material with a finish dimension) carries a Natural/Brushed/
-- Mirror choice the customer can still make at order time — independent of the
-- approved artwork. The order builder now lets the designer pick it; this
-- column records which material_option was chosen so the checkout can apply
-- the matching material_option_surcharge and the Xero line can name the finish.
--
-- Nullable: most orders (no finish dimension, or the base finish) leave it null.
-- Table-level grants from 000176 already cover new columns, so no re-grant.

alter table proofs.orders
  add column if not exists material_option_id uuid references proofs.material_options(id);

comment on column proofs.orders.material_option_id is
  'Chosen material option (e.g. metal finish: Natural/Brushed/Mirror). Drives the option surcharge applied at checkout. Null = no finish dimension or the base option.';
