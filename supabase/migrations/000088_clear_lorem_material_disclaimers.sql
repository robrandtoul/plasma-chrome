-- Migration 000088: clear lorem ipsum material disclaimers
--
-- Migration 000016 seeded materials.disclaimer with a two-
-- paragraph lorem ipsum block ("Sed ut perspiciatis… / Nemo
-- enim ipsam…") on any material whose code was in
-- ('metal_steel', 'paper_letterpress'). That seed was never
-- cleaned up — 000033 only replaced the sibling lorem on
-- site_settings.global_disclaimer — so the lorem has been
-- rendering in the customer-page "About {material}" section
-- on every proof for those materials.
--
-- Production was cleaned manually via the Supabase SQL editor
-- on 2026-04-23. This migration exists so a fresh dev build
-- that replays the full migration chain lands in the same
-- state as production rather than reintroducing the lorem.
--
-- Match is on the lorem text itself, not on material code —
-- any material whose disclaimer has since been edited to real
-- copy (on a dev instance that's been in use) will be
-- untouched. Running this twice is a no-op: after the first
-- run the lorem is gone and no rows match.
--
-- Out of scope: editing 000016 itself (immutable history),
-- touching seed.sql, and any application-code change. The
-- render path at CustomerProofPage.tsx:1226 already guards
-- the second paragraph with `material_disclaimer && …`, so
-- nulling the column makes the section collapse cleanly to
-- just the material_description paragraph.

begin;

update materials
set disclaimer = null
where disclaimer like '%Sed ut perspiciatis%'
   or disclaimer like '%Nemo enim ipsam%';

commit;
