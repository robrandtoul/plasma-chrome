-- Migration 000171: tighten profile self-update to also lock the
-- admin-managed fields.
--
-- Migration 000165 restored self-edit on profiles with a WITH CHECK that
-- prevents role escalation (a designer can't UPDATE their own row to set
-- role='admin'). Security sweep found the WITH CHECK only covers `role`,
-- leaving two other admin-managed columns mutable by the row owner:
--
--   * helpscout_user_id (migration 000123) — drives per-designer
--     attribution on Help Scout staff replies. A designer setting their
--     own helpscout_user_id to another designer's HS user id would have
--     send-helpscout-reply attribute their replies to that user in the
--     HS workspace. Internal-only impersonation, but a real authorial-
--     identity gap.
--
--   * deactivated_at (migration 000036) — admin-managed lockout column.
--     A designer who could UPDATE their own row could clear their own
--     deactivation by writing null. Mostly self-DoS on the lockout
--     direction (writing a timestamp locks themselves out), but the
--     ability to clear it is the asymmetric risk: a deactivated designer
--     could un-deactivate themselves if their session token is still
--     valid post-deactivation.
--
-- Both columns join role in the WITH CHECK: the new value must equal
-- the currently-stored value, computed via a single subquery against
-- the same profile row. Self-editable fields (full_name,
-- designer_initials, designer_colour, avatar_url) stay unrestricted —
-- the policy already gates on auth.uid() = id so only the row owner
-- can update at all.
--
-- DROP + CREATE rather than ALTER POLICY for forwards-compatibility:
-- ALTER POLICY's WITH CHECK syntax is supported, but the surrounding
-- migrations use DROP + CREATE for policy changes consistently and
-- this preserves the pattern. The grant on UPDATE was implicit via
-- `to authenticated`; preserved here.

begin;

drop policy if exists "profiles: owner update own profile" on profiles;

create policy "profiles: owner update own profile"
  on profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- The WITH CHECK clause is evaluated against the proposed new row;
    -- each `<field>` here refers to the NEW value. The subqueries read
    -- the CURRENT stored value off the same row, so any difference
    -- means the caller attempted to mutate an admin-managed field and
    -- the policy fails. `is not distinct from` rather than `=` because
    -- helpscout_user_id and deactivated_at are nullable — `null = null`
    -- is NULL in SQL, which would fail the check on legitimately-null
    -- columns.
    and role is not distinct from (
      select p.role from profiles p where p.id = auth.uid()
    )
    and helpscout_user_id is not distinct from (
      select p.helpscout_user_id from profiles p where p.id = auth.uid()
    )
    and deactivated_at is not distinct from (
      select p.deactivated_at from profiles p where p.id = auth.uid()
    )
  );

commit;
