-- Migration 000048: repair the material-icons storage policies
--
-- The policies added in 000047 referenced `is_admin()` unqualified.
-- Storage policies aren't guaranteed to have `public` in their
-- search_path, which resulted in the function not resolving and every
-- admin upload failing with "new row violates row-level security
-- policy". Qualify the call and recreate.

begin;

drop policy if exists "material-icons: admin upload" on storage.objects;
drop policy if exists "material-icons: admin update" on storage.objects;
drop policy if exists "material-icons: admin delete" on storage.objects;

create policy "material-icons: admin upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'material-icons' and public.is_admin());

create policy "material-icons: admin update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'material-icons' and public.is_admin());

create policy "material-icons: admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'material-icons' and public.is_admin());

commit;
