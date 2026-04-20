-- Migration 000057: add the missing SELECT policy on material-icons
--
-- supabase-js's `upsert: true` option performs a pre-write check that
-- needs SELECT on storage.objects for the existing path. Without a
-- SELECT policy any upload (new or replacement) fails with
-- "new row violates row-level security policy". Mirror the
-- proof-images setup: authenticated users can read objects in the
-- material-icons bucket. Public read via the bucket's public flag is
-- unchanged; this just opens the RLS path.

begin;

-- Also restore public=true on the bucket; 000056 flipped it off while
-- diagnosing. The customer page relies on the public URL pattern.
update storage.buckets set public = true where id = 'material-icons';

drop policy if exists "material-icons: authenticated read" on storage.objects;

create policy "material-icons: authenticated read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'material-icons');

-- anon select isn't needed here: public=true on the bucket serves the
-- customer page via the public URL path without hitting storage.objects
-- RLS at all.

commit;
