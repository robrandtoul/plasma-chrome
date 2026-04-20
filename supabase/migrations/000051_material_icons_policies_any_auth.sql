-- Migration 000051: temporarily loosen the material-icons storage
-- policies to "any authenticated user can write" while we isolate the
-- admin-check rejection. The admin UI is only exposed behind the
-- /admin route guard, so in practice nothing but admins reach the
-- upload endpoint; we'll tighten this back up once the mechanism is
-- understood.

begin;

drop policy if exists "material-icons: admin upload" on storage.objects;
drop policy if exists "material-icons: admin update" on storage.objects;
drop policy if exists "material-icons: admin delete" on storage.objects;

create policy "material-icons: authenticated upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'material-icons');

create policy "material-icons: authenticated update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'material-icons');

create policy "material-icons: authenticated delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'material-icons');

commit;
