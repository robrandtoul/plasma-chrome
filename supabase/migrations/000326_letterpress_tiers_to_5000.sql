-- 000326: extend the letterpress price ladder from 2000 up to 5000 cards.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Both letterpress materials (paper_letterpress, paper_letterpress_gilded)
-- currently top out at quantity 2000. Their ladder runs 100 -> 2000 in steps
-- of 25 (77 tiers) across all three currencies, for each of the 8 ink-count
-- variants -- so 16 variants total.
--
-- This adds the 25-step ladder onward, 2025 -> 5000 (120 new quantities), for
-- every variant/currency: 16 variants x 3 currencies x 120 quantities =
-- 5,760 new rows.
--
-- PRICING RULE (Rob, 2026-07-17): the per-card price is HELD FLAT at the 2000
-- rate for every quantity above 2000 -- the volume discount does not continue
-- past 2000. So for each variant/currency:
--
--   unit_at_2000 = total_price(2000) / 2000
--   total_price(q) = round(unit_at_2000 * q)   -- nearest whole currency unit
--   unit_price(q)  = round(total_price(q) / q, 4)
--
-- Derived in SQL from the live 2000-tier row (no hardcoded figures), so the
-- new tiers can never drift from the 2000 price they extend. Totals are
-- rounded to whole pounds/euros/dollars to match the existing whole-number
-- grid; that rounding wobbles the stored unit_price by at most +/-0.0002
-- around the 2000 rate (~0.02p per card, and unit_price is not customer-
-- facing). Every 2000-tier total across the 16 variants is a clean 4-dp
-- per-card figure, so the arithmetic lands on tidy whole-number totals.
--
-- Note this makes cards above 2000 marginally DEARER per extra card than the
-- pre-2000 trend (the discount curve was still gently falling at 2000), which
-- is the business-safe direction and exactly the intent of "stop the discount
-- at 2000".
--
-- GBP is VAT-inclusive; EUR and USD are VAT-free (unchanged convention).
--
-- Idempotent: price_tiers has a unique constraint on
-- (material_variant_id, currency, quantity), so ON CONFLICT DO NOTHING makes a
-- second run insert nothing. No new quantities exist above 2000 today, so the
-- guard is pure belt-and-braces.

begin;

insert into proofs.price_tiers (material_variant_id, currency, quantity, total_price, unit_price)
select
  base.material_variant_id,
  base.currency,
  q.quantity,
  round(base.unit_at_2000 * q.quantity)::numeric(10, 2)                       as total_price,
  round(round(base.unit_at_2000 * q.quantity) / q.quantity, 4)::numeric(10, 4) as unit_price
from (
  select
    pt.material_variant_id,
    pt.currency,
    pt.total_price / 2000.0 as unit_at_2000
  from proofs.materials m
  join proofs.material_variants mv on mv.material_id = m.id
  join proofs.price_tiers pt on pt.material_variant_id = mv.id
  where m.code in ('paper_letterpress', 'paper_letterpress_gilded')
    and pt.quantity = 2000
) base
cross join generate_series(2025, 5000, 25) as q(quantity)
on conflict (material_variant_id, currency, quantity) do nothing;

commit;
