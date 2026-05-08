-- Migration 000145: backfill qty 25 surcharge rows for metal finishes
--
-- Context: at some earlier point the Steel and Gold base price tiers
-- were extended down to quantity 25, but the matching surcharge rows
-- in material_option_surcharges (covering the Brushed and Mirror
-- options on those two materials) were never extended to match.
-- That left the spread quote unable to resolve a finish surcharge at
-- quantity 25 even though base pricing was available — the compiler
-- flagged "nearest tier above: 50" instead of returning a price.
--
-- Rob's confirmed the qty 25 finish surcharge across all metal cards
-- at £20 GBP / €20 EUR / $20 USD. The survey of
-- material_option_surcharges identified exactly four schedules in
-- need: Steel + Brushed, Steel + Mirror, Gold + Brushed, Gold +
-- Mirror. No other metal options carry a surcharge schedule today
-- (Natural is the no-surcharge base; wood species, etc. have no
-- surcharge rows at all and so don't apply).
--
-- Insert is wrapped in ON CONFLICT DO NOTHING so it's safe to re-run
-- (e.g. against a database where the rows have already been backfilled
-- through some other path).

begin;

insert into material_option_surcharges (material_option_id, currency, quantity, surcharge)
select mo.id, curr.currency, 25, curr.surcharge
from material_options mo
join materials m on m.id = mo.material_id
cross join (
  values
    ('GBP'::char(3), 20.00::numeric(10,2)),
    ('EUR'::char(3), 20.00::numeric(10,2)),
    ('USD'::char(3), 20.00::numeric(10,2))
) as curr(currency, surcharge)
where m.code in ('metal_steel', 'metal_gold')
  and mo.code in ('brushed', 'mirror')
on conflict (material_option_id, currency, quantity) do nothing;

commit;
