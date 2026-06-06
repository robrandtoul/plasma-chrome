-- ============================================================================
--  scripts/scrub-test-data.sql
--
--  ⚠️  ONE-TIME, DESTRUCTIVE, GO-LIVE DATA SCRUB — *NOT* A MIGRATION.  ⚠️
--
--  Permanently deletes ALL customer data accumulated during the trial period
--  so the app starts on a clean slate for real customers. Run this MANUALLY,
--  ONCE, in the Supabase SQL editor (or `supabase db execute`) against the
--  LIVE project, as the postgres / service role (which bypasses RLS).
--
--  This file deliberately lives in scripts/ and NOT in supabase/migrations/.
--  Migrations replay on every fresh database; a destructive DELETE has no
--  business running as part of a replay. Do not move it, do not number it.
--
--  DELETES (all test data):
--    proofs + every cascading proof_* child (versions, images, layouts,
--    round variants, views, approvals, events, pins, snoozes),
--    contacts, companies, audit_log, fedex_rate_cache.
--
--  KEEPS (real / structural — never touched here):
--    pricing catalogue (materials, material_variants, price_tiers,
--    material_options, material_option_surcharges, letterpress_core_colours,
--    personalisation_pricing, add_ons, …), admin config (settings,
--    site_settings, app_settings, reply_templates), designer accounts
--    (profiles).
--
--  STORAGE IS NOT HANDLED HERE. After running this, empty the `proof-images`
--  bucket with `pnpm db:empty-proof-images` (scripts/empty-proof-images-bucket.ts)
--  or the Supabase Dashboard. The `avatars` and `material-icons` buckets stay.
--
--  ── BEFORE YOU RUN ──────────────────────────────────────────────────────
--    1. Take a database backup: Dashboard → Database → Backups.
--    2. Run STEP 1 on its own and read the counts. Make sure they look like
--       the test data you expect to lose.
--    3. Only then run STEP 2, then STEP 3 to verify.
--
--  Safety design: every delete is wrapped in one transaction (STEP 2) — it
--  all lands or none of it does. Children are deleted before parents, so the
--  order is valid on its own and respects the two RESTRICT foreign keys
--  (proofs.contact_id, contacts.company_id). All primary keys are UUIDs, so
--  there are no sequences to reset.
--
--  Precedent: scripts/clean-test-fixtures.ts uses the same FK reasoning, but
--  is scoped to is_test_fixture rows only. This file wipes everything.
-- ============================================================================


-- ----------------------------------------------------------------------------
--  STEP 1 — PRE-FLIGHT.  Run this block ALONE first and read the numbers.
--           These are exactly the rows STEP 2 will permanently delete.
-- ----------------------------------------------------------------------------
select 'proofs'                  as table_name, count(*) as rows from proofs
union all select 'proof_versions',          count(*) from proof_versions
union all select 'proof_version_images',    count(*) from proof_version_images
union all select 'proof_layouts',           count(*) from proof_layouts
union all select 'proof_round_variants',    count(*) from proof_round_variants
union all select 'proof_version_views',     count(*) from proof_version_views
union all select 'proof_name_approvals',    count(*) from proof_name_approvals
union all select 'proof_events',            count(*) from proof_events
union all select 'proof_pins',              count(*) from proof_pins
union all select 'proof_attention_snoozes', count(*) from proof_attention_snoozes
union all select 'contacts',                count(*) from contacts
union all select 'companies',               count(*) from companies
union all select 'audit_log',               count(*) from audit_log
union all select 'fedex_rate_cache',        count(*) from fedex_rate_cache
order by table_name;


-- ----------------------------------------------------------------------------
--  STEP 2 — THE SCRUB.  Wrapped in a transaction. Children before parents.
-- ----------------------------------------------------------------------------
begin;

delete from proof_name_approvals;
delete from proof_events;
delete from proof_version_views;
delete from proof_version_images;   -- before layouts / round_variants (cascade FKs into both)
delete from proof_layouts;          -- Set-collection layouts (migration 000210)
delete from proof_round_variants;
delete from proof_versions;
delete from proof_pins;
delete from proof_attention_snoozes;
delete from proofs;
delete from contacts;               -- unblocked once proofs are gone (contact_id is RESTRICT)
delete from companies;              -- unblocked once contacts are gone (company_id is RESTRICT)
delete from audit_log;              -- wipe the trial-period activity trail
delete from fedex_rate_cache;       -- just a server-side rate cache; repopulates on demand

commit;


-- ----------------------------------------------------------------------------
--  STEP 3 — VERIFY.  Run after STEP 2.
--           Every SCRUBBED row should read 0. Every KEPT row should be
--           unchanged (catalogue/config/staff untouched).
-- ----------------------------------------------------------------------------
select 'SCRUBBED — expect 0' as section, 'proofs'   as table_name, count(*) as rows from proofs
union all select 'SCRUBBED — expect 0', 'proof_versions',          count(*) from proof_versions
union all select 'SCRUBBED — expect 0', 'proof_version_images',    count(*) from proof_version_images
union all select 'SCRUBBED — expect 0', 'proof_layouts',           count(*) from proof_layouts
union all select 'SCRUBBED — expect 0', 'proof_round_variants',    count(*) from proof_round_variants
union all select 'SCRUBBED — expect 0', 'proof_version_views',     count(*) from proof_version_views
union all select 'SCRUBBED — expect 0', 'proof_name_approvals',    count(*) from proof_name_approvals
union all select 'SCRUBBED — expect 0', 'proof_events',            count(*) from proof_events
union all select 'SCRUBBED — expect 0', 'proof_pins',              count(*) from proof_pins
union all select 'SCRUBBED — expect 0', 'proof_attention_snoozes', count(*) from proof_attention_snoozes
union all select 'SCRUBBED — expect 0', 'contacts',                count(*) from contacts
union all select 'SCRUBBED — expect 0', 'companies',               count(*) from companies
union all select 'SCRUBBED — expect 0', 'audit_log',               count(*) from audit_log
union all select 'SCRUBBED — expect 0', 'fedex_rate_cache',        count(*) from fedex_rate_cache
union all select 'KEPT — expect > 0',   'materials',               count(*) from materials
union all select 'KEPT — expect > 0',   'material_variants',       count(*) from material_variants
union all select 'KEPT — expect > 0',   'price_tiers',             count(*) from price_tiers
union all select 'KEPT — expect > 0',   'profiles',                count(*) from profiles
union all select 'KEPT — expect > 0',   'reply_templates',         count(*) from reply_templates
union all select 'KEPT — expect 1',     'settings',                count(*) from settings
union all select 'KEPT — expect 1',     'site_settings',           count(*) from site_settings
union all select 'KEPT — expect 1',     'app_settings',            count(*) from app_settings
order by section, table_name;
