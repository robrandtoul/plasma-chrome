-- Migration 000079: extend ink_count variants to 5–8
--
-- Every material with variant_type = 'ink_count' currently has
-- exactly four variants (1–4 inks). Real-world orders sometimes
-- call for 5, 6, 7, or 8 inks. Those have no per-tier pricing, so
-- they're handled as custom quotes — the absence of price_tiers
-- rows is the signal that the NewVersionPage form uses to flip
-- into custom-quote mode.
--
-- This migration just adds the missing variant rows. No
-- price_tiers inserts. No changes to existing variants. The
-- (material_id, code) unique constraint + ON CONFLICT DO NOTHING
-- make this idempotent, so re-applying is safe.
--
-- Shape mirrors the existing pattern verified against live data:
--   code           'N_ink' (singular, even when N > 1)
--   display_name   '1 Ink' for N=1, 'N Inks' for N >= 2
--   sort_order     N * 10  (10, 20, 30, ..., 80)
--   variant_type   'ink_count'
--   ink_count      N
--   is_active      true

begin;

insert into material_variants
  (material_id, code, display_name, variant_type, ink_count, sort_order, is_active)
select
  m.id,
  n || '_ink',
  n || ' Inks',
  'ink_count',
  n,
  n * 10,
  true
from materials m
cross join generate_series(5, 8) as n
where exists (
  select 1 from material_variants mv
  where mv.material_id = m.id
    and mv.variant_type = 'ink_count'
)
on conflict (material_id, code) do nothing;

commit;
