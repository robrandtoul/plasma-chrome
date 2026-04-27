-- Migration 000119: proof_events column shape — single price → grid snapshot.
--
-- Phase 2 Prompt 1 (000116) added two flat audit columns to
-- proof_events:
--
--   total_price_at_action  numeric
--   currency_at_action     text
--
-- The intent was to capture exactly what the customer agreed to
-- price-wise. But quantity isn't decided at approval time —
-- customers approve a proof, then we issue an invoice once they
-- confirm a quantity, often days later. Capturing a single price
-- was therefore inadequate: we'd be picking an arbitrary tier
-- (which one?) and the audit field wouldn't actually answer the
-- "what did the customer see when they approved?" question.
--
-- The right shape is the entire pricing grid (every priced
-- variant × quantity combo) the customer was looking at when they
-- clicked the action. That's the same JSONB shape pricing_snapshot
-- on proof_versions used until Phase 2's flip — variants[] each
-- with a prices map keyed by quantity. The edge function in this
-- same commit builds that shape live from price_tiers + variant
-- filter at action time and stores it here.
--
-- Both old columns are dropped wholesale rather than migrated.
-- proof_events has zero rows at the moment this migration applies
-- (table was created in 000116, the edge function doesn't ship
-- until this same commit) so there's no data-loss consideration.
-- ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS for idempotency.

begin;

alter table proof_events drop column if exists total_price_at_action;
alter table proof_events drop column if exists currency_at_action;

alter table proof_events
  add column if not exists pricing_snapshot_at_action jsonb;

comment on column proof_events.pricing_snapshot_at_action is
  'Complete pricing grid the customer was looking at when they '
  'clicked Approve / Request changes. Same JSONB shape as '
  'proof_versions.pricing_snapshot ({ variants: [{ variant_id, '
  'display, prices: { qty: number } }] }) — built live from '
  'price_tiers + the version''s displayed_variant_ids at action '
  'time by the proof-action edge function. Replaces the flat '
  'total_price_at_action / currency_at_action pair that was '
  'inadequate because quantity is decided after approval.';

commit;
