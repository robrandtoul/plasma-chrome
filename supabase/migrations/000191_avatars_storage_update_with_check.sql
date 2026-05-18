-- Migration 000191: tighten the avatars storage UPDATE policy to
-- include a WITH CHECK clause as well as USING (PV-2026W21-077).
--
-- 000166 shipped the "avatars: owner update" policy with only a
-- USING clause asserting the existing row's first path segment is
-- the caller's auth.uid(). On UPDATE, Postgres RLS uses USING to
-- decide which rows the caller can touch and WITH CHECK to validate
-- the post-update state. With WITH CHECK omitted, a caller who is
-- allowed to update one of their own avatar objects could in
-- principle rename it into someone else's folder via the storage
-- REST API, because the post-update first-path-segment is never
-- checked.
--
-- This is a theoretical surface today: the storage REST UPDATE
-- endpoint is typically used to update metadata (e.g. cache-control)
-- rather than rename objects, and the supabase-js client doesn't
-- expose a rename helper that would hit this path. But the
-- defence-in-depth pattern across the rest of the repo (see 000165
-- and 000171 on profiles, 000159 on proof_pins, 000167 on
-- proof_attention_snoozes) is to always carry both clauses on policies
-- that gate mutation. Mirror that here.
--
-- Drop and recreate with both clauses asserting the same predicate.

begin;

drop policy if exists "avatars: owner update" on storage.objects;

create policy "avatars: owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
