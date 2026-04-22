-- Migration 000085: backfill proof_version_images.side
--
-- Historical context:
--   * proof_version_images.side was added by migration 000071
--     ('front' | 'back' | NULL). The column has been populated
--     inconsistently: some rows carry explicit front/back, others
--     are NULL. Now that the new-version designer flow exposes
--     explicit sidedness + per-side slots, every new row will
--     stamp side non-null. Back-compat in the designer and
--     customer paths treats NULL as 'front' at read time, but
--     that's fragile — backfilling tightens the invariant.
--
-- Pre-flight confirmed against live data: 12 rows, 6 non-null
-- ('front' / 'back'), 6 NULL. No conflicting state.
--
-- public_proof_version_images view already projects side (confirmed
-- via pg_get_viewdef); no view update needed.
--
-- NOT adding a NOT NULL constraint in this migration — keeping the
-- column nullable avoids any future RPC / service-role INSERT path
-- that forgets to stamp side from failing hard. App-layer enforces
-- non-null on user-driven writes; belt-and-braces null-tolerance
-- stays at the read layer.

begin;

update proof_version_images
set side = 'front'
where side is null;

commit;
