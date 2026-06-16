-- 000231: Xero OAuth connection store (Ordering & checkout, Step 5b).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- Holds the single Xero connection: the rotating refresh token, the tenant
-- (org) id, and a cached access token. Xero refresh tokens ROTATE on every
-- use, so they must be stored and updated — they can't live in a static
-- env secret. Singleton row (id = 1), like settings.
--
-- SENSITIVE: these tokens grant access to the Xero org. The proofs schema's
-- ALTER DEFAULT PRIVILEGES (000176) would otherwise grant `authenticated`
-- full CRUD on any new table, so we REVOKE explicitly and grant ONLY
-- service_role (the edge functions). RLS on with zero policies — no
-- authenticated/anon path in at all.

create table if not exists proofs.xero_connection (
  id                       int primary key default 1 check (id = 1),
  tenant_id                text,
  refresh_token            text,
  access_token             text,
  access_token_expires_at  timestamptz,
  -- CSRF state for the one-time OAuth authorise round-trip.
  pending_state            text,
  updated_at               timestamptz not null default now()
);

alter table proofs.xero_connection enable row level security;
revoke all on proofs.xero_connection from anon, authenticated;
grant all on proofs.xero_connection to service_role;

insert into proofs.xero_connection (id) values (1) on conflict do nothing;
