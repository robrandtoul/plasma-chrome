-- 000329_team_roster_rpc.sql
--
-- Fix: non-admin staff (every "designer" role) see NO direct-message pills and
-- get NO @mention autocomplete in the team chat.
--
-- The chat's `members` list — one DM pill per teammate, plus the @mention
-- candidate list and message-author avatar/name lookups — is loaded with a
-- direct read of proofs.profiles (src/lib/teamChatStore.tsx):
--     select id, full_name, designer_initials, designer_colour, avatar_url
--       from profiles where deactivated_at is null
-- But proofs.profiles has only two SELECT policies:
--     "profiles: owner select"  → auth.uid() = id   (your own row)
--     "profiles: admin select"  → proofs.is_admin()  (admins see everyone)
-- so a designer's query returns ONLY their own row. `members` collapses to
-- [me], `members` minus self is empty, and the whole DM/mention surface is
-- blank. Admins (who built + tested it) saw the full roster, which is why it
-- looked like it worked. Reported by Donna Lambe (a designer).
--
-- Fix, without widening what the sensitive columns expose: a SECURITY DEFINER
-- reader owned by postgres (bypasses RLS on its inner read, same device as
-- proofs.is_admin() and proofs.profile_self_edit_ok() from 000327) that returns
-- ONLY the five roster columns chat needs, for active staff, to any
-- authenticated caller. role / helpscout_user_id / deactivated_at stay behind
-- the admin-only base-table policies — they are never selected here.
--
-- Staff-only: EXECUTE is revoked from anon/public and granted to authenticated
-- (there is no customer auth in this app; customer pages read via anon RPCs).

create or replace function proofs.team_roster()
returns table (
  id                uuid,
  full_name         text,
  designer_initials text,
  designer_colour   text,
  avatar_url        text
)
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  select id, full_name, designer_initials, designer_colour, avatar_url
  from profiles
  where deactivated_at is null
  order by full_name;
$$;

revoke execute on function proofs.team_roster() from anon, public;
grant execute on function proofs.team_roster() to authenticated;
