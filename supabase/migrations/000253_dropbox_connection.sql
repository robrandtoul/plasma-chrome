-- 000253_dropbox_connection.sql
--
-- Single-row Dropbox connection for the Orders hand-off (reading the order
-- folder's name + prepped artwork). The dropbox-folder edge function reads
-- this row, refreshes the short-lived access token from the long-lived refresh
-- token (token_access_type=offline), and caches the access token back here.
-- Mirrors proofs.xero_connection.
--
-- No row is seeded in this migration — the credentials (app key/secret +
-- refresh token) are inserted out-of-band so they never land in source.

create table if not exists proofs.dropbox_connection (
  id int primary key default 1 check (id = 1),
  app_key text not null,
  app_secret text not null,
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  account_id text,
  updated_at timestamptz not null default now()
);

-- Service-role only (the edge function uses the service key). The proofs
-- schema's ALTER DEFAULT PRIVILEGES (000176) would otherwise grant authenticated
-- CRUD on this new table, so revoke it explicitly (the fedex_rate_cache footgun
-- from 000178) and enable RLS with no policies. service_role bypasses RLS.
alter table proofs.dropbox_connection enable row level security;
revoke all on proofs.dropbox_connection from anon, authenticated;
grant all on proofs.dropbox_connection to service_role;
