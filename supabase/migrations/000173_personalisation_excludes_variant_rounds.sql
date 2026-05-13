-- Migration 000173: belt-and-braces CHECK enforcing that variant
-- rounds cannot carry the personalisation add-on.
--
-- Personalisation is a membership-card add-on on the standard
-- (single-variant-bucket) pricing grid. Variant rounds are
-- inherently a different product shape: parallel design
-- alternatives, often with per-direction pricing. The customer
-- page never renders the Personalisation line for variant rounds
-- (the !is_per_direction_pricing gate catches per-direction
-- rounds; shared-pricing rounds aren't designed to surface it
-- either). NewVersionPage hard-codes has_personalisation = false
-- on the variant-round insert path, and migration 000173's
-- partner change to EditVersionPage adds !isVariantRound to that
-- form's gates. This CHECK is the DB-level guarantee — a future
-- direct write, seed, or admin script can't accidentally land a
-- has_personalisation = true row on a variant round.
--
-- Today's data is clean: no existing row has
-- (is_variant_round = true AND has_personalisation = true). The
-- migration adds the constraint NOT VALID first then VALIDATEs
-- separately so a future replay against a polluted environment
-- would surface the bad rows in a separate validation step
-- rather than blocking the ALTER itself.

begin;

alter table proof_versions
  add constraint proof_versions_personalisation_excludes_variant_round
  check (not (is_variant_round and has_personalisation))
  not valid;

alter table proof_versions
  validate constraint proof_versions_personalisation_excludes_variant_round;

comment on constraint proof_versions_personalisation_excludes_variant_round
  on proof_versions is
  'Personalisation (migration 000172) is incompatible with variant '
  'rounds (migration 000138). Form-side: NewVersionPage hard-codes '
  'has_personalisation = false on the variant-round path, '
  'EditVersionPage''s render + save gates include !isVariantRound. '
  'This CHECK is the DB-level backstop against direct writes.';

commit;
