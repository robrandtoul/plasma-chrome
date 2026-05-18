-- Migration 000187: drop the dead dashboard_tile_counts() function
-- (PV-2026W21-042).
--
-- 000170 reshaped this function to the three-tile signature
-- (needs_attention, dormant, approved_this_week) after the dashboard
-- moved every tile count to client-side computation against
-- public_dashboard_projects. The 000170 header noted that no consumers
-- in the frontend call it, but kept the function in place "so a future
-- caller could pick it up." Six months on, no caller has, and the
-- function's existence is a small drift risk: a future change to the
-- predicate semantics in one place would need a mirrored change here,
-- with no compile-time signal to enforce the mirror.
--
-- Drop it. If a future caller wants a single-round-trip tile count, a
-- replacement function can be reintroduced at that point with whatever
-- predicates are current.

begin;

drop function if exists dashboard_tile_counts();

commit;
