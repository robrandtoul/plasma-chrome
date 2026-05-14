-- Migration 000176: explicit grants on every public-schema table for the
-- Supabase 30 October 2026 enforcement.
--
-- ── Why ───────────────────────────────────────────────────────────────
--
-- On 2026-10-30 Supabase removes the implicit
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role
-- plus the matching ALTER DEFAULT PRIVILEGES that auto-granted on every
-- newly-created table. After that date, REST writes from the frontend's
-- authenticated session — companies, contacts, proofs, proof_versions,
-- proof_version_images, proof_name_approvals, proof_pins,
-- proof_attention_snoozes, profiles, plus every admin-only catalogue
-- table — will start returning "permission denied for table …" unless
-- the grants are restated explicitly in source.
--
-- Migration 000162 (anon enumeration fix) already explicitly re-granted
-- SELECT to authenticated on the tables it revoked from anon. That
-- covered reads, but the implicit grant is what carries today's
-- INSERT/UPDATE/DELETE. This migration adds the missing write verbs on
-- every table authenticated actually writes, explicit SELECT on the
-- handful 000162 didn't touch, and ALTER DEFAULT PRIVILEGES so future
-- tables created in this schema inherit the same grants automatically.
--
-- Deliberately NOT granting anon or public anything. 000162 routes all
-- customer-page reads through public_get_customer_proof(uuid)
-- (SECURITY DEFINER); a grant here would re-open the enumeration
-- surface that migration closed.
--
-- ── How the grant matrix was derived ──────────────────────────────────
--
-- By grepping src/ + supabase/functions/ for
--   .from('<table>').(insert|upsert|update|delete)
-- per table — NOT from a hand-curated "read-only lookup" list. Several
-- catalogue tables (price_tiers, material_variants, material_option_
-- surcharges, letterpress_core_colours, personalisation_pricing,
-- add_on_prices) ARE written from authenticated sessions via the admin
-- pages (RLS gates access to the admin role). The four tables that are
-- only ever inserted via service-role edge functions (audit_log,
-- proof_events) or SECURITY DEFINER RPCs (proof_version_views via
-- record_proof_view) get SELECT only here — their write paths bypass
-- table-level grants anyway. material_options and add_ons are read-only
-- from authenticated. app_settings is a legacy unused table; SELECT
-- only as a defensive placeholder.

begin;

-- ── Full CRUD to authenticated (20 tables) ────────────────────────────

grant select, insert, update, delete on companies                  to authenticated;
grant select, insert, update, delete on contacts                   to authenticated;
grant select, insert, update, delete on proofs                     to authenticated;
grant select, insert, update, delete on proof_versions             to authenticated;
grant select, insert, update, delete on proof_version_images       to authenticated;
grant select, insert, update, delete on proof_name_approvals       to authenticated;
grant select, insert, update, delete on proof_round_variants       to authenticated;
grant select, insert, update, delete on proof_pins                 to authenticated;
grant select, insert, update, delete on proof_attention_snoozes    to authenticated;
grant select, insert, update, delete on profiles                   to authenticated;
grant select, insert, update, delete on materials                  to authenticated;
grant select, insert, update, delete on material_variants          to authenticated;
grant select, insert, update, delete on material_option_surcharges to authenticated;
grant select, insert, update, delete on price_tiers                to authenticated;
grant select, insert, update, delete on add_on_prices              to authenticated;
grant select, insert, update, delete on letterpress_core_colours   to authenticated;
grant select, insert, update, delete on personalisation_pricing    to authenticated;
grant select, insert, update, delete on reply_templates            to authenticated;
grant select, insert, update, delete on site_settings              to authenticated;
grant select, insert, update, delete on settings                   to authenticated;

-- ── SELECT only to authenticated (6 tables) ───────────────────────────
--
-- Writes flow exclusively via service-role edge functions or SECURITY
-- DEFINER RPCs, both of which bypass table-level grants. material_
-- options + add_ons are genuinely read-only from authenticated.
-- app_settings is a legacy unused table.

grant select on material_options    to authenticated;
grant select on add_ons             to authenticated;
grant select on audit_log           to authenticated;
grant select on proof_version_views to authenticated;
grant select on proof_events        to authenticated;
grant select on app_settings        to authenticated;

-- ── Sequences ─────────────────────────────────────────────────────────
--
-- No-op today (every table uses UUID PKs), but defensively covers any
-- future serial / generated-as-identity column without that migration
-- needing to remember to grant.

grant usage, select on all sequences in schema public to authenticated;

-- ── Default privileges for future tables / sequences ──────────────────
--
-- Any table created in a future migration inherits CRUD by default. If
-- a future table is meant to be SELECT-only for authenticated, that
-- migration should follow up with a targeted
--   revoke insert, update, delete on <table> from authenticated;
-- — same pattern 000162 used for the anon SELECT revokes.

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

alter default privileges in schema public
  grant usage, select on sequences to authenticated;

commit;
