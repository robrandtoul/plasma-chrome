-- 000323: let team-chat attachments be ANY file type, not just images.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema + the storage schema. Apply via the dashboard SQL editor / an MCP
-- apply_migration. Do NOT use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration.
--
-- Rationale: the chat is a handy way to fire a file across the team (a PDF, an
-- SVG, an AI, a font). 000322 locked the bucket to images and 10 MB. This:
--   1. widens the `chat-attachments` bucket to allow any mime type and raises
--      the per-file cap to 25 MB;
--   2. adds `attachment_files jsonb` on team_messages so each attachment keeps
--      its ORIGINAL filename / type / size — the storage key is a random uuid,
--      so without this a non-image would download as a meaningless name.
--
-- The private bucket + owner-folder RLS from 000322 is unchanged: uploads are
-- still gated to signed-in staff writing into their own {user_id}/… folder,
-- reads are still signed-URL only. Widening the mime list does not touch who
-- can upload — only what shapes are accepted.

begin;

-- 1. Any file type, 25 MB cap (was images-only, 10 MB in 000322).
update storage.buckets
set allowed_mime_types = null,       -- null = no mime restriction
    file_size_limit = 26214400       -- 25 MB
where id = 'chat-attachments';

-- 2. Per-attachment metadata, so the download carries the real filename. The
--    array is [{ path, name, type, size }] in send order; legacy image
--    messages (attachment_paths only) fall back to image thumbnails client-side.
alter table proofs.team_messages
  add column if not exists attachment_files jsonb not null default '[]'::jsonb;

comment on column proofs.team_messages.attachment_files is
  'per-attachment metadata [{path,name,type,size}] preserving the original '
  'filename/type/size (the storage key is a random uuid). Added in 000323; '
  'attachment_paths stays populated in lockstep for backward compatibility.';

commit;
