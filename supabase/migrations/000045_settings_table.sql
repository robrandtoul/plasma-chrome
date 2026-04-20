-- Migration 000045: singleton settings table + public read RPC
--
-- The old site_settings table only carried the global disclaimer.
-- The new `settings` table is the long-term home for every tweakable
-- app-level value: customer-facing copy, designer defaults, and space
-- for future rows. site_settings stays in place but becomes unused —
-- leaving the old data alone avoids surprises.
--
-- RLS: admins read/write the table directly. Authenticated designers
-- need SELECT so they can pick up default_pricing_display and
-- default_currency. Anon (customer-facing page) goes through
-- public_settings() which exposes only the customer-visible subset.

begin;

create table settings (
  id                       int         primary key default 1,

  -- Customer-facing
  disclaimer_text          text        not null default '',
  company_name             text        not null default 'PlasmaDesign Ltd',
  reply_email              text        not null default '',

  -- Designer defaults
  default_pricing_display  text        not null default 'standard'
    check (default_pricing_display in ('standard', 'custom_quote')),
  default_currency         text        not null default 'GBP'
    check (default_currency in ('GBP', 'EUR', 'USD')),

  -- Audit
  updated_at               timestamptz not null default now(),
  updated_by               uuid        references auth.users(id),

  constraint single_row check (id = 1)
);

-- Seed the row. Pull the current disclaimer over from site_settings so
-- nothing changes visually on the customer page after this migration.
insert into settings (id, disclaimer_text)
  select 1, coalesce(global_disclaimer, '')
  from site_settings
  where id = 1
  on conflict (id) do nothing;

-- Fallback if site_settings was somehow empty — keeps settings row valid.
insert into settings (id) values (1) on conflict do nothing;

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table settings enable row level security;

create policy "settings: authenticated read"
  on settings for select to authenticated using (true);

create policy "settings: admin update"
  on settings for update to authenticated using (is_admin());

-- No insert/delete — a single locked row, by design.

-- ── Public read RPC ─────────────────────────────────────────────────────────
--
-- SECURITY DEFINER so anon (the customer-facing page) can call it
-- without needing table-level grants. Returns only the customer-visible
-- subset — designer-only defaults stay private.

create or replace function public_settings()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'disclaimer_text', disclaimer_text,
    'company_name',    company_name,
    'reply_email',     reply_email
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;

commit;
