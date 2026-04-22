-- Migration 000086: card_type column on proof_versions
--
-- Replaces the "empty names array means membership" inference
-- that shipped in 4ec9a87 with an explicit card_type column.
-- The inference held while membership meant "one design for
-- everyone", but now membership can carry tier variants
-- (Bronze/Silver/Gold, etc.) stored in names[] the same way
-- business cards store recipient names. Without an explicit
-- column there'd be no way to tell a "single-design business
-- card" project (empty names) apart from a "tiered membership"
-- project (non-empty names).
--
-- Check constraint keeps the column a closed enum; UI only
-- ever writes the two values. NOT NULL with default 'business'
-- means existing pre-4ec9a87 business-card rows need no
-- backfill — they default in place. Membership rows from
-- 4ec9a87 are identified by cardinality(names) = 0 and flipped
-- to 'membership' in the same transaction as the ADD COLUMN so
-- the constraint never sees a state where a 4ec9a87 membership
-- row is mis-typed.
--
-- public_proof_versions view intentionally not updated — the
-- customer page derives everything it needs from the existing
-- images + names fields, and card_type is a designer-only
-- concept. Adding it to the view would only make sense if the
-- customer page later grew card-type-specific copy, which is
-- deferred.

begin;

alter table proof_versions
  add column card_type text not null default 'business';

update proof_versions
  set card_type = 'membership'
  where cardinality(names) = 0;

alter table proof_versions
  add constraint proof_versions_card_type_check
  check (card_type in ('business', 'membership'));

commit;
