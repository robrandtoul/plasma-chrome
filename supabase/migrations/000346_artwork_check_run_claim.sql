-- Artwork check: one run at a time per order (docs/artwork-check-spec.md).
--
-- The normal order-prep flow fires the check TWICE, in parallel. Linking the
-- Dropbox folder fires the 000337 trigger (force:true); the reviewer then
-- opens the review page seconds later, which auto-runs the check itself, and
-- with no report cached yet that second call does a whole second run. Both
-- write orders.artwork_check blind, so the LAST to finish wins — and the run
-- the reviewer is actually reading is usually the other one.
--
-- Observed on live, order 403922 (2026-07-26): folder linked 11:00:12 → run A
-- (trigger) starts; page opens 11:00:17 → run B starts; run B finishes
-- 11:01:23 and is what the reviewer read; run A finishes 11:01:34 and
-- overwrites the stored report; the order was placed at 11:02:20. Two
-- consequences, both bad: two full Opus passes over the print files per order
-- (real money), and the stored record of what the check said is a different
-- run from the one the human signed off. It also broke the per-flag
-- Investigate button, which resolves a flag against the STORED report —
-- the model rewords card labels every run ("Andrew Forbes — back" vs
-- "Andrew Forbes — back (03_AndrewForbes_Steel.ai)"), so the lookup missed.
--
-- The claim: the edge function stamps this column before starting a run and
-- clears it in the same patch that stores the report. A caller that finds it
-- already stamped (and fresh) waits for that run's report instead of starting
-- its own — so the page shows exactly what the database ends up holding.
-- A stamp older than the staleness window is treated as abandoned (a crashed
-- or timed-out run must never wedge an order out of being checked).
--
-- orders only, deliberately: the pre-send PROOF check (000343) has no
-- auto-run trigger and is driven from one page by one designer, so it has no
-- structural race to close. Its stored/rendered divergence is handled in the
-- function by tolerant flag matching instead.
--
-- Rides the existing proofs.orders grants, so no grant work. Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.
--
-- ⚠ Deploy order: apply this BEFORE deploying artwork-check. The function's
-- order select names the new column, so a function deploy against an
-- unmigrated database fails every order check at the lookup. The frontend is
-- order-independent (it only reads new response fields).

alter table proofs.orders
  add column if not exists artwork_check_running_at timestamptz;

comment on column proofs.orders.artwork_check_running_at is
  'Set while an artwork check is running for this order; cleared when the report is stored. A second caller waits for that run rather than starting a duplicate. A stamp older than the function''s staleness window counts as abandoned.';
