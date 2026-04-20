-- Migration 000050: inline the admin check in material-icons policies
--
-- Prior migrations tried `is_admin()` and `public.is_admin()` in the
-- storage policies and both still rejected admin uploads with "new row
-- violates row-level security policy". Storage RLS evaluation doesn't
-- appear to resolve the function in the expected schema. Inline the
-- profile lookup so there's no function resolution to worry about.

begin;

drop policy if exists "material-icons: admin upload" on storage.objects;
drop policy if exists "material-icons: admin update" on storage.objects;
drop policy if exists "material-icons: admin delete" on storage.objects;

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
