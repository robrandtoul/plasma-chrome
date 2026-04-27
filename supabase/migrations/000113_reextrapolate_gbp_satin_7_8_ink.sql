-- 000113_reextrapolate_gbp_satin_7_8_ink.sql
--
-- Re-extrapolates GBP plastic_satin 7-ink and 8-ink prices at qty
-- 2025-5000 using the corrected 3-ink and 4-ink base laid down by
-- 000110.
--
-- Background: 000109 extended plastic_satin to 5/6/7/8 inks by linear
-- extrapolation from the existing 3-ink and 4-ink rows:
--   p5 = 2·p4 − p3,  p6 = 3·p4 − 2·p3,
--   p7 = 4·p4 − 3·p3, p8 = 5·p4 − 4·p3
-- For GBP at qty 2025-5000, the 3-ink and 4-ink base used by 000109
-- was wrong (drifted below GBP plastic_translucent). 000110 corrects
-- the base. 000110 also implicitly corrects 5-ink and 6-ink at those
-- qtys by joining onto the now-corrected GBP plastic_translucent (which
-- has 5-ink and 6-ink rows from 000109).
--
-- 7-ink and 8-ink are NOT covered by 000110 because translucent has no
-- 7/8-ink rows to copy from. They need re-extrapolation from the freshly
-- corrected 3/4-ink base. ~240 cells affected (120 quantities x 2
-- variants).
--
-- EUR and USD are unaffected: their plastic_satin 3/4-ink base was
-- already correct, so the extrapolated 5-8 ink rows are already correct.
--
-- DEPENDS ON: 000110 having run (otherwise this migration would re-derive
-- 7/8-ink from the still-wrong 3/4-ink base and leave the same drift in
-- place).
--
-- Idempotent: re-running on already-correct rows is a no-op via the
-- WHERE clause guard.

begin;

with satin_base as (
  -- The corrected GBP satin 3-ink and 4-ink base, laid down by 000110.
  select
    pt.quantity,
    max(case when mv.code = '3_ink' then pt.total_price end) as p3_total,
    max(case when mv.code = '4_ink' then pt.total_price end) as p4_total
  from price_tiers pt
  join material_variants mv on mv.id = pt.material_variant_id
  join materials m on m.id = mv.material_id
  where m.code = 'plastic_satin'
    and pt.currency = 'GBP'
    and pt.quantity between 2025 and 5000
    and mv.code in ('3_ink', '4_ink')
  group by pt.quantity
),
target_prices as (
  select
    sb.quantity,
    mv.id as variant_id,
    mv.code as variant_code,
    case mv.code
      when '7_ink' then sb.p4_total * 4 - sb.p3_total * 3
      when '8_ink' then sb.p4_total * 5 - sb.p3_total * 4
    end as new_total
  from satin_base sb
  cross join material_variants mv
  join materials m on m.id = mv.material_id
  where m.code = 'plastic_satin'
    and mv.code in ('7_ink', '8_ink')
)
update price_tiers pt
set total_price = tp.new_total,
    unit_price  = round(tp.new_total / pt.quantity, 4)
from target_prices tp
where pt.material_variant_id = tp.variant_id
  and pt.currency = 'GBP'
  and pt.quantity = tp.quantity
  and (pt.total_price <> tp.new_total
       or pt.unit_price <> round(tp.new_total / pt.quantity, 4));

commit;
