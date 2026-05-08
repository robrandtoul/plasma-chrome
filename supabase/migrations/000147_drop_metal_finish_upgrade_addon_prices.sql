-- Migration 000147: drop the orphan add_on_prices rows for the
-- Mirror / Brushed Finish Upgrade add-on.
--
-- Background: the admin Mirror/Brushed editor used to read and
-- write `add_on_prices` for the metal_finish_upgrade add-on, but
-- the customer-facing compiler reads `material_option_surcharges`
-- — the two were a parallel pricing system, and the values in
-- add_on_prices never reached the customer-facing flow. The PART 2
-- repoint moves the editor onto material_option_surcharges, so
-- the add_on_prices rows are now dead data.
--
-- We keep the `metal_finish_upgrade` row in `add_ons` because the
-- admin route `/admin/pricing/add-ons/metal_finish_upgrade` still
-- targets it as a UI key. The pricing-model + display-name on the
-- catalogue row are still meaningful; only the add_on_prices rows
-- get dropped.
--
-- Idempotent: re-running on an already-cleaned DB is a no-op
-- (DELETE matches zero rows).

begin;

delete from add_on_prices
using add_ons
where add_on_prices.add_on_id = add_ons.id
  and add_ons.code = 'metal_finish_upgrade';

commit;
