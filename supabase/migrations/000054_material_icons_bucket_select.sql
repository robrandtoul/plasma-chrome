-- Migration 000054: let clients see the material-icons bucket row
--
-- storage.buckets has RLS enabled but no project-level SELECT policies.
-- Without bucket visibility the supabase-js storage client rejects
-- uploads with "new row violates row-level security policy" even when
-- the objects-level INSERT policy would allow the write. Adding an
-- authenticated-SELECT policy on the bucket row fixes the upload path
-- without exposing bucket metadata to anonymous users.

begin;

create policy "material-icons: bucket visible to authenticated"
  on storage.buckets for select
  to authenticated
  using (id = 'material-icons');

-- Restore the admin-only writes (000051 relaxed these to "any
-- authenticated"; now that we've isolated the bucket-visibility issue,
-- lock them back down to admins).
drop policy if exists "material-icons: authenticated upload" on storage.objects;
drop policy if exists "material-icons: authenticated update" on storage.objects;
drop policy if exists "material-icons: authenticated delete" on storage.objects;

create policy "material-icons: admin upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'material-icons'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy "material-icons: admin update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'material-icons'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy "material-icons: admin delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'material-icons'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

commit;
