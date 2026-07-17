-- 000322: image attachments on team-chat messages.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration.
--
-- Same shape as the feedback board's attachments (000271): a text[] of storage
-- keys on the message + a private bucket, paths keyed {user_id}/… so the
-- owner-insert policy gates on the first path segment. Read via signed URLs.

begin;

alter table proofs.team_messages
  add column if not exists attachment_paths text[] not null default '{}';

comment on column proofs.team_messages.attachment_paths is
  'storage object keys in the chat-attachments bucket (read via signed URL). Added in 000322.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760,  -- 10 MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

drop policy if exists "chat-attachments: authenticated read" on storage.objects;
drop policy if exists "chat-attachments: owner insert" on storage.objects;
drop policy if exists "chat-attachments: owner or admin delete" on storage.objects;

-- Any signed-in staffer can read any chat image (the channel is shared).
create policy "chat-attachments: authenticated read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'chat-attachments');

-- You can only write into your own {user_id}/… folder.
create policy "chat-attachments: owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete your own; an admin can clean up anyone's.
create policy "chat-attachments: owner or admin delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'chat-attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or proofs.is_admin()
    )
  );

commit;
