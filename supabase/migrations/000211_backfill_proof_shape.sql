-- Migration 000211: backfill proof_versions.shape from existing flags.
--
-- 000210 added the nullable shape column; this migration fills it in for
-- existing rows by deriving from the flags that encoded the shape before
-- the wizard existed. Separate, idempotent migration (decision 1 in the
-- Phase 2 spec): re-running it is a no-op because every UPDATE is guarded
-- by `shape is null`, so it never clobbers a value the wizard wrote.
--
-- Derivation (matches the Phase 1 reverse-mapping in
-- ProofShapeWizard.deriveAnswersFromShape):
--
--   selection   ← is_variant_round = true
--                 (per-direction pricing is still a selection; the
--                  is_per_direction_pricing flag stays the sub-mode)
--   set_single  ← is_variant_round = false
--                 AND card_type = 'membership'
--                 AND names is empty   (one shared, no-name design)
--   recipients  ← is_variant_round = false
--                 AND card_type = 'business'
--
-- Deliberately NOT mapped (left null): is_variant_round = false,
-- card_type = 'membership', names NON-empty — legacy gold/silver/bronze
-- tier-membership proofs. Under the new model these are conceptually a
-- collection, but their tiers live in names (not proof_layouts), so
-- there is no honest shape to assign. Null is correct: the frontend
-- falls back to flag-based rendering for null shape, so these legacy
-- rows are completely unaffected. No live row is set_collection.
--
-- Inert on production behaviour: shape is read by new Phase 2 code only;
-- existing pages ignore it.

begin;

-- selection
update proof_versions
   set shape = 'selection'
 where shape is null
   and is_variant_round = true;

-- set_single (no-name shared design)
update proof_versions
   set shape = 'set_single'
 where shape is null
   and is_variant_round = false
   and card_type = 'membership'
   and coalesce(array_length(names, 1), 0) = 0;

-- recipients (standard per-recipient proof)
update proof_versions
   set shape = 'recipients'
 where shape is null
   and is_variant_round = false
   and card_type = 'business';

commit;
