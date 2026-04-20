-- Migration 000036: admin user management
--
-- Second pass on the admin area (after 000035 introduced the role column
-- and is_admin() helper). This one adds the soft-delete marker, the RLS
-- surface the Users page needs, a last-admin safety trigger, and a
-- SECURITY DEFINER helper that joins profiles with auth.users so the
-- frontend can list users in one query.

begin;

-- ── 1. Soft-delete marker ────────────────────────────────────────────────────

alter table profiles
  add column deactivated_at timestamptz;

-- full_name already exists on profiles from the initial create_profiles
-- migration, so nothing to add there.

-- ── 2. RLS policies ──────────────────────────────────────────────────────────
--
-- The original owner-update was too permissive — a user could promote
-- themselves to admin. Drop it and let admins handle profile edits via
-- the admin area. Non-admins can still read their own row for the
-- frontend's useAuth role check.

drop policy if exists "profiles: owner update" on profiles;

create policy "profiles: admin select"
  on profiles for select
  to authenticated
  using (is_admin());

create policy "profiles: admin update"
  on profiles for update
  to authenticated
  using (is_admin());

-- No delete policy — deletions happen by cascade from auth.users only.

-- ── 3. Last-admin safety net ─────────────────────────────────────────────────
--
-- The frontend blocks self-demotion too, but this trigger catches any
-- direct RPC/REST attempt to empty the admin pool.

create or replace function prevent_last_admin_demotion()
returns trigger
language plpgsql
as $$
declare
  admin_count int;
begin
  if OLD.role = 'admin' and NEW.role <> 'admin' then
    select count(*) into admin_count
      from profiles
      where role = 'admin'
        and deactivated_at is null;
    if admin_count <= 1 then
      raise exception 'Cannot remove the last admin — promote another user to admin first'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger trg_prevent_last_admin_demotion
  before update on profiles
  for each row
  execute function prevent_last_admin_demotion();

-- ── 4. Listing helper ────────────────────────────────────────────────────────
--
-- auth.users lives outside the exposed API schemas, so we bridge via a
-- SECURITY DEFINER function that first checks is_admin() then joins.

create or replace function admin_list_users()
returns table (
  id              uuid,
  email           text,
  full_name       text,
  role            text,
  deactivated_at  timestamptz,
  created_at      timestamptz,
  last_sign_in_at timestamptz
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
    u.last_sign_in_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where is_admin()
  order by p.created_at desc
$$;

grant execute on function admin_list_users() to authenticated;

commit;
