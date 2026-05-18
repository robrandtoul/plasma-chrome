-- Migration 000185: defensive REVOKE of write privileges on
-- personalisation_pricing from anon and the public role.
--
-- personalisation_pricing was added in 000172 as an admin-managed
-- catalogue table (one row per currency: per-card rate + minimum
-- charge). The table's RLS policies already gate writes to admins,
-- but 000176 added an `alter default privileges ... grant all on
-- tables to authenticated` that, going forward, hands full CRUD to
-- every authenticated user on every future table. Tables that
-- pre-date 000176 (like this one) carry whatever grants they
-- already had — and on a fresh replay those defaults could shift.
--
-- The defence-in-depth fix is to restate the grants explicitly:
-- revoke INSERT/UPDATE/DELETE from anon and public so RLS isn't
-- the only thing standing between an authenticated session and a
-- direct REST write to the catalogue. SELECT stays open (it's
-- already public read-only via the rows being exposed through
-- public_get_customer_proof's nested map).
--
-- Same pattern as the explicit `revoke all ... from anon,
-- authenticated` 000178 installs on fedex_rate_cache. Captures
-- PV-2026W21-002 / PV-2026W21-053 from the weekly audit.
--
-- Idempotent: re-running the migration is a no-op on a DB where
-- the grants are already revoked (REVOKE on already-absent
-- privileges silently succeeds).

begin;

revoke insert, update, delete on personalisation_pricing from anon, public;

commit;
