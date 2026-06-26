-- 000271: staff feedback board — bugs & feature ideas.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- An in-app suggestion box for staff: anyone logged in can post a bug or idea
-- and see everyone else's; only an admin moves an item through the status
-- pipeline (new → under_review → planned → in_progress → done / wont_do).
-- Screenshots (optionally marked up in-app) attach via a private storage
-- bucket. App-level feedback — deliberately NOT tied to a customer proof.
--
-- Two parts:
--   1. proofs.feedback_items table + RLS + grants
--   2. feedback-attachments private storage bucket + object policies
--
-- ⚠ Grants note (the proofs schema has NO default privileges — a new table is
-- born with no grants at all, service_role included): every grant below is
-- explicit. Submitter display fields are DENORMALISED onto the row because
-- profiles is self-read-only under RLS, so a join can't show "submitted by
-- Chris" — same idiom as audit_log's actor_label and the dashboard snooze
-- columns. created_by / status_changed_by stay as FKs (ON DELETE SET NULL) for
-- attribution + the insert RLS check. The *_name/_initials/_colour copies are
-- for display only and are stamped server-side by a BEFORE INSERT trigger from
-- the caller's own profile row, so the visible author can't be spoofed via a
-- direct REST insert (the client never supplies them).
--
-- Admin gates use the existing proofs.is_admin() helper (SECURITY DEFINER,
-- search_path-pinned) — the house pattern (000074 … 000259) — rather than an
-- inline profiles subquery.

begin;

-- ── 1. feedback_items ────────────────────────────────────────────────────────

create table proofs.feedback_items (
  id                    uuid        primary key default gen_random_uuid(),
  -- Attribution: FK for the insert RLS check + delete-own; nullable so the row
  -- survives account removal (ON DELETE SET NULL), matching snoozed_by/sent_by.
  created_by            uuid        references proofs.profiles(id) on delete set null,
  -- Denormalised submitter, for display on the shared board (profiles is
  -- self-read-only, so these can't be joined back later).
  created_by_name       text,
  created_by_initials   text,
  created_by_colour     text,
  type                  text        not null default 'idea'
                          check (type in ('bug', 'idea', 'improvement')),
  title                 text        not null,
  body                  text,
  -- Optional free-text "which page / area does this relate to?" — more reliable
  -- than auto-capturing a SPA route, and useful for triaging bug reports.
  area                  text,
  status                text        not null default 'new'
                          check (status in ('new', 'under_review', 'planned',
                                            'in_progress', 'done', 'wont_do')),
  -- Admin triage note, shown to everyone on the board ("Planned for next week").
  admin_note            text,
  -- Storage object keys in the feedback-attachments bucket (read via signed URL).
  attachment_paths      text[]      not null default '{}',
  status_changed_at     timestamptz,
  status_changed_by     uuid        references proofs.profiles(id) on delete set null,
  status_changed_by_name text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Default board sort is newest-first; the status filter clicks the second one.
create index feedback_items_created_idx on proofs.feedback_items (created_at desc);
create index feedback_items_status_idx  on proofs.feedback_items (status, created_at desc);

alter table proofs.feedback_items enable row level security;

-- Everyone signed in sees the whole board.
create policy feedback_items_select on proofs.feedback_items
  for select to authenticated using (true);

-- Anyone signed in can post, but only as themselves (created_by = auth.uid()
-- blocks spoofing another person's attribution via a direct REST insert).
create policy feedback_items_insert on proofs.feedback_items
  for insert to authenticated
  with check (created_by = auth.uid());

-- Only an admin moves an item through the pipeline / edits the triage note.
create policy feedback_items_admin_update on proofs.feedback_items
  for update to authenticated
  using (proofs.is_admin())
  with check (proofs.is_admin());

-- An author can withdraw their own post; an admin can remove anything.
create policy feedback_items_delete on proofs.feedback_items
  for delete to authenticated
  using (created_by = auth.uid() or proofs.is_admin());

revoke all on proofs.feedback_items from anon, public;
grant select, insert, update, delete on proofs.feedback_items to authenticated;
grant all on proofs.feedback_items to service_role;

comment on table proofs.feedback_items is
  'Staff feedback / suggestion board (bugs + feature ideas). Anyone '
  'authenticated reads all + inserts their own; only admins UPDATE the '
  'status/admin_note. App-level, not tied to a proof. Submitter display fields '
  'are denormalised because profiles is self-read-only under RLS, and stamped '
  'server-side by feedback_items_set_author so they can''t be spoofed.';

-- Stamp the denormalised submitter fields from the caller's own profile row,
-- so the client never supplies (and can't falsify) the displayed author. FK
-- created_by is already forced to auth.uid() by the insert RLS check; this
-- reads that profile. SECURITY DEFINER so it can read profiles regardless of
-- that table's self-read-only RLS; EXECUTE revoked from callers (a trigger
-- fires regardless of EXECUTE — same hardening as 000182).
create or replace function proofs.feedback_items_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  select p.full_name, p.designer_initials, p.designer_colour
    into new.created_by_name, new.created_by_initials, new.created_by_colour
  from proofs.profiles p
  where p.id = new.created_by;
  return new;
end;
$$;

revoke execute on function proofs.feedback_items_set_author() from public, anon, authenticated;
grant execute on function proofs.feedback_items_set_author() to service_role;

create trigger feedback_items_set_author
  before insert on proofs.feedback_items
  for each row execute function proofs.feedback_items_set_author();

-- ── 2. feedback-attachments storage bucket ───────────────────────────────────
-- Private (public=false): screenshots may carry customer data, so reads go via
-- signed URLs. 10 MB cap (retina screenshots are large). Paths are
-- {user_id}/{uuid}.png so the owner-write RLS can gate on the first segment,
-- exactly like the avatars bucket (000166).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-attachments',
  'feedback-attachments',
  false,
  10485760,  -- 10 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled globally in Supabase.
-- Drop any prior attempts so this migration is safe to re-run.
drop policy if exists "feedback-attachments: authenticated read" on storage.objects;
drop policy if exists "feedback-attachments: owner insert"        on storage.objects;
drop policy if exists "feedback-attachments: owner or admin delete" on storage.objects;

-- Any signed-in staffer can read any feedback screenshot (the board is shared).
create policy "feedback-attachments: authenticated read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'feedback-attachments');

-- A staffer can only write into their own {user_id}/… folder.
create policy "feedback-attachments: owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- The owner can delete their own files; an admin can clean up anyone's (so
-- deleting another staffer's feedback item doesn't strand its screenshots).
create policy "feedback-attachments: owner or admin delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'feedback-attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or proofs.is_admin()
    )
  );

commit;
