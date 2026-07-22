-- Artwork check: a 'defect' verdict tier (docs/artwork-check-spec.md).
--
-- Amber lumped together "a human should glance" and "this is almost certainly
-- a defect" — Snap-on's possibly-intentional title wore the same ⚠ as
-- Everest's will-bounce email. Findings now carry a severity graded against a
-- strict "would we bet a reprint on it" bar (three categories only:
-- functionally broken value / explicit written instruction not carried out /
-- print file contradicts the approved proof), and a report containing any
-- defect-grade flag gets verdict 'defect' — the red ✗ tier. Red stays
-- ADVISORY: the place-order gate still only requires that a check has RUN.
--
-- This migration just widens the verdict CHECK so the Orders-page chip can
-- read the tier off the existing column without fetching report jsonb.
-- Severity itself lives inside artwork_check (no new columns).
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

alter table proofs.orders
  drop constraint if exists orders_artwork_check_verdict_check;
alter table proofs.orders
  add constraint orders_artwork_check_verdict_check
  check (artwork_check_verdict is null or artwork_check_verdict in ('clear', 'flagged', 'defect', 'error'));

comment on column proofs.orders.artwork_check_verdict is
  'clear | flagged | defect | error — the latest report''s verdict, for Orders-page chips without parsing the jsonb. defect = at least one flag graded to the "bet a reprint on it" bar; still advisory.';
