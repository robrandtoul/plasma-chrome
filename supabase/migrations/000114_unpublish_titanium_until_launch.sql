-- 000114_unpublish_titanium_until_launch.sql
--
-- Pre-launch hold on the Titanium row in materials. Hides it from
-- every designer-facing surface that filters on is_published, while
-- keeping its priced data (1 variant × 120 price tiers across GBP/
-- EUR/USD) intact in the database.
--
-- This is NOT a retirement. Titanium is a future product; the row
-- stays here, fully priced and ready to launch. When launch day
-- arrives, the change is one-line: flip is_published back to true.
--
-- LAUNCH-DAY CHECKLIST (when Titanium goes live):
--   1. Flip is_published back to true on this row
--      (UPDATE materials SET is_published = true WHERE code = 'metal_titanium').
--   2. Add Titanium to the public pricing pages on plasmadesign.co.uk.
--   3. Any other surface that should advertise it (homepage,
--      product carousels, marketing copy).
--
-- Surfaces affected by this hold today:
--   - Quote compiler material picker (/quote)
--   - New-version form material picker (/proofs/:id/versions/new)
--   Both filter on (is_active=true, is_published=true, archived_at IS NULL),
--   so flipping is_published to false hides Titanium from both in one
--   shot.
--
-- Surfaces NOT affected:
--   - Admin pricing page (uses is_active=true only — admins still
--     manage Titanium's data here).
--   - Any historical proof_version that already references Titanium
--     keeps working — the filter only gates new pickers, not reads
--     against existing rows.
--
-- Idempotent: the WHERE clause includes is_published = true so a
-- second run is a no-op. The row count after one apply is 1; on
-- any subsequent apply it's 0.

begin;

update materials
set
  is_published = false,
  updated_at = now()
where
  code = 'metal_titanium'
  and is_published = true;

commit;
