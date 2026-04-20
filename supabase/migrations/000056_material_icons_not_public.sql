-- Migration 000056: test whether public=true on the bucket breaks uploads
-- Temporarily flip to false. Customer page read access will instead rely
-- on signed URLs if needed — but first confirm the upload path works.

begin;

update storage.buckets set public = false where id = 'material-icons';

commit;
