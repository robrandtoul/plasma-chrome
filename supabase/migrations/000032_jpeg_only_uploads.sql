-- Migration 000032: restrict proof-images bucket to JPEG only
--
-- Rob's call: all production proofs come out of the design tool as JPEGs
-- anyway, so removing PNG keeps a single consistent format and avoids the
-- odd PNG upload that bloats storage. File-size cap stays at 10 MB.

begin;

update storage.buckets
  set allowed_mime_types = array['image/jpeg']
  where id = 'proof-images';

commit;
