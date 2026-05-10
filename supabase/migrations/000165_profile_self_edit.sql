-- Migration 000165: allow designers to edit their own profile
--
-- Migration 000036 dropped the original "profiles: owner update" policy to
-- prevent users promoting themselves to admin. That was correct, but it also
-- left everyone unable to update their own display fields (full_name,
-- designer_initials, designer_colour).
--
-- This migration restores self-edit access with a WITH CHECK clause that
-- asserts the role column on the incoming row matches the role currently
-- stored for that user. A direct API call that attempts to flip role from
-- 'designer' to 'admin' will fail the check and be rejected by Postgres
-- before it reaches the application layer.

begin;

create policy "profiles: owner update own profile"
  on profiles for update
  to authenticated
  using  (auth.uid() = id)
  with check (
    auth.uid() = id
    -- The WITH CHECK clause is evaluated against the proposed new row.
    -- `role` here is the NEW value; the subquery reads the CURRENT stored
    -- value. If they differ (i.e. the caller tried to change their role)
    -- the check fails and Postgres rejects the update.
    and role = (select p.role from profiles p where p.id = auth.uid())
  );

commit;
