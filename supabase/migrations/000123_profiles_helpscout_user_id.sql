-- Migration 000123: per-designer Help Scout user attribution.
--
-- Adds profiles.helpscout_user_id so each designer can have their own
-- Help Scout staff user id used as the `user` field on staff replies
-- via send-helpscout-reply. Null = fall back to the project-wide
-- HELPSCOUT_DEFAULT_USER_ID env var (the existing behaviour).
--
-- Additive only:
--   * ADD COLUMN ... NULL — every existing row reads as NULL (the
--     fallback path), so no behaviour change for any designer who
--     hasn't been mapped.
--   * No uniqueness constraint, no foreign key. Help Scout user ids
--     live in a system we don't control; storing them as a plain
--     nullable integer keeps the migration cheap.
--
-- Replaces admin_list_users() to include the new column so the
-- AdminUsersPage table can render the per-designer mapping. Same
-- security_definer + is_admin() gate as the original (000036).

begin;

alter table profiles
  add column helpscout_user_id integer null;

comment on column profiles.helpscout_user_id is
  'The Help Scout user ID this designer is attributed to when sending '
  'staff replies. Null = use the project-wide HELPSCOUT_DEFAULT_USER_ID '
  'env var.';

-- Postgres won't CREATE OR REPLACE a function whose RETURNS TABLE
-- shape has changed (the original 000036 returns 7 columns; we're
-- adding an 8th). DROP first, then CREATE — same effect, allowed
-- by Postgres. The grant on the new function lands at the bottom.
drop function if exists admin_list_users();

create function admin_list_users()
returns table (
  id                 uuid,
  email              text,
  full_name          text,
  role               text,
  deactivated_at     timestamptz,
  created_at         timestamptz,
  last_sign_in_at    timestamptz,
  helpscout_user_id  integer
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p.id,
    u.email::text       as email,
    p.full_name,
    p.role,
    p.deactivated_at,
    p.created_at,
    u.last_sign_in_at,
    p.helpscout_user_id
  from public.profiles p
  join auth.users u on u.id = p.id
  where is_admin()
  order by p.created_at desc
$$;

grant execute on function admin_list_users() to authenticated;

commit;
