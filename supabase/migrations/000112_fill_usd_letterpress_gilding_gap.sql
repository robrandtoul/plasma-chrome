-- 000112_fill_usd_letterpress_gilding_gap.sql
--
-- INTENTIONALLY EMPTY — DO NOT APPLY.
--
-- Original intent: fill 6 missing USD letterpress_gilding rows in
-- add_on_prices for qty 250-2000.
--
-- Withdrawn 2026-04-26 because the migration was built on a retired
-- data model. Migration 000098 deleted `letterpress_gilding` from the
-- add_ons table and converted gilded letterpress into a separate
-- material `paper_letterpress_gilded` with its own variants and
-- price_tiers. Migrations 000105 / 000106 already cover the USD range
-- in question under the new model.
--
-- This file is kept (rather than deleted) so the migration sequence
-- remains contiguous and to leave a paper trail of why nothing landed
-- here. Safe to remove if your migration tooling tolerates gaps.

begin;
-- no-op
commit;
