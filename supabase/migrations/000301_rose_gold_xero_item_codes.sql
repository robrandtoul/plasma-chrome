-- 000301: Rose Gold Metal's own Xero item codes.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- 000300 cloned rose gold's variants from Gold Metal including gold's item
-- codes (0146/0147/01475), on the assumption rose gold had always been
-- invoiced as gold. Rob's Xero org in fact already carries dedicated rose
-- gold items (screenshot, 2026-07-03):
--   0148  — Rose gold metal cards (300 micron)
--   0149  — Rose gold metal cards (500 micron)
--   01495 — Rose gold metal cards (800 micron)
-- Point the three variants at them so paid rose gold orders invoice on the
-- right lines. The finish options keep the cloned (metal-generic) upgrade
-- item code. Keyed by variant code for idempotent replay.

update proofs.material_variants v
set xero_item_code = c.item_code
from (values ('300um', '0148'), ('500um', '0149'), ('800um', '01495')) as c(variant_code, item_code),
     proofs.materials m
where m.code = 'metal_rose_gold'
  and v.material_id = m.id
  and v.code = c.variant_code
  and v.xero_item_code is distinct from c.item_code;
