-- Migration 000035: admin role foundation
--
-- First of four migrations establishing an admin area in the app. This
-- one only sets up the infrastructure — the column on profiles and an
-- is_admin() helper other RLS policies will hang off later. No tables
-- are gated to admins yet (that lands with the user + pricing work in
-- the next prompts).

begin;

-- ── 1. Role column on profiles ───────────────────────────────────────────────

alter table profiles
  add column role text not null default 'designer'
    check (role in ('admin', 'designer'));

-- Explicit backfill for any rows that predate the default. The column
-- default would handle new rows, but this guarantees every existing row
-- has a value before any policy reads it.
update profiles set role = 'designer' where role is null;

-- ── 2. is_admin() helper ──────────────────────────────────────────────────────
--
-- Security definer so later RLS policies can gate on it without the
-- function itself being blocked by profile-row RLS when called from a
-- context that doesn't own the row.

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function is_admin() to authenticated;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Manual promote snippet — run once in the Supabase SQL editor after
-- signing up, replacing the email if needed. Not part of this migration
-- because we don't want the app-owner email baked into version control.
--
-- UPDATE profiles
--   SET role = 'admin'
--   WHERE id = (SELECT id FROM auth.users WHERE email = 'rob.randtoul@gmail.com');
-- ─────────────────────────────────────────────────────────────────────────────
