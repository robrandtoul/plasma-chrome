-- 000327_fix_profiles_update_policy_recursion.sql
--
-- Fix: "infinite recursion detected in policy for relation profiles" on EVERY
-- authenticated UPDATE of proofs.profiles.
--
-- The "owner update own profile" policy (000165, extended 000171) locks role,
-- helpscout_user_id and deactivated_at against self-mutation by comparing the
-- incoming NEW row to the caller's stored row via three
-- `select ... from proofs.profiles` subqueries INSIDE the policy's WITH CHECK.
-- A policy on a table that reads that same table recurses, and Postgres aborts
-- the statement outright. The symptom is silent on the app side: the write is
-- rejected and only a console error is logged, so
--   - profiles.team_chat_seen_at   (team-chat unread badge)
--   - profiles.orders_seen_at      (Orders "payments received" badge)
--   - profiles.feedback_seen_at    (feedback badge)
--   - self-service profile edits    (name / initials / colour / avatar)
-- never persist. The reported case: the chat unread badge shows "9+" on every
-- refresh because the seen-stamp is stuck at the 000319 backfill timestamp.
--
-- (Reads are unaffected — the SELECT policies use proofs.is_admin(), which is
-- SECURITY DEFINER owned by postgres and so bypasses RLS on its inner read. The
-- recursion is specific to the WITH CHECK reading proofs.profiles directly.)
--
-- Fix without weakening the lock: move the "are my locked columns unchanged?"
-- read into a SECURITY DEFINER helper (owned by postgres, which bypasses RLS),
-- exactly like proofs.is_admin(). The policy then calls the function instead of
-- reading proofs.profiles directly, so there is no self-reference to recurse on.
-- Verified 2026-07-17 in a rolled-back transaction: admin + designer seen-stamp
-- updates succeed, and a designer role-escalation attempt is still blocked.

create or replace function proofs.profile_self_edit_ok(
  p_role text,
  p_helpscout_user_id integer,
  p_deactivated_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  -- True iff the caller's stored row still carries these exact locked values —
  -- i.e. the incoming UPDATE did not change role / helpscout_user_id /
  -- deactivated_at. `is not distinct from` so nullable columns compare correctly.
  -- Runs as postgres (definer) so this inner read bypasses RLS and cannot
  -- recurse into the profiles policies.
  select exists (
    select 1
    from profiles p
    where p.id = (select auth.uid())
      and p.role is not distinct from p_role
      and p.helpscout_user_id is not distinct from p_helpscout_user_id
      and p.deactivated_at is not distinct from p_deactivated_at
  );
$$;

revoke execute on function proofs.profile_self_edit_ok(text, integer, timestamptz) from anon, public;
grant execute on function proofs.profile_self_edit_ok(text, integer, timestamptz) to authenticated;

drop policy if exists "profiles: owner update own profile" on proofs.profiles;

create policy "profiles: owner update own profile"
on proofs.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check (
  (select auth.uid()) = id
  and proofs.profile_self_edit_ok(role, helpscout_user_id, deactivated_at)
);
