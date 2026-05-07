-- Migration 000143: variant rounds — backfill side='front' on
-- existing variant-round images.
--
-- 000071 introduced the proof_version_images.side column (CHECK
-- 'front' / 'back' / NULL). Variant rounds (000138 / 000139)
-- shipped with side=null on every image because the upload UI
-- treated each variant as a single bucket. The build-plan addition
-- now adds per-variant Front + optional Back sides, so the
-- customer page filters images by side. Existing variant-round
-- images need to be flagged as Front so they render under the new
-- front-cluster path; otherwise they'd disappear from the variant
-- card.
--
-- Standard versions: untouched. Their side column is already set
-- per the existing two-sided flow (where applicable).
--
-- The validate_variant_round_image trigger (000138) doesn't
-- constrain side, so the new 'front' / 'back' values flow through
-- without a trigger change. CHECK ('front' | 'back') from 000071
-- is the only constraint and it already permits both.
--
-- Backfill set: images whose parent version is_variant_round = true
-- and whose side IS NULL. Bounded scan; runs once.

begin;

update proof_version_images pvi
   set side = 'front'
  from proof_versions pv
 where pvi.proof_version_id = pv.id
   and pv.is_variant_round = true
   and pvi.side is null;

commit;
