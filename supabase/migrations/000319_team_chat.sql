-- 000319: team chat — one shared internal message channel for the four of us.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this.
--
-- We work in different locations and currently message across disparate systems.
-- This is one internal channel, right inside the dashboard we all live in.
-- Lightweight by design: ONE shared channel (no DMs, no multiple rooms), plain
-- text, delete-your-own. A "someone messaged you" phone push is a deliberate
-- later pass — the header unread badge covers us while the app is open.
--
-- Design decisions:
--   * EVERYONE READS + POSTS. for select using (true); insert only as yourself
--     (author_id = auth.uid() blocks spoofing another person's attribution via a
--     direct REST insert). This is a team channel, not an admin broadcast — that
--     is what the announcements banner (000318) is for.
--   * IMMUTABLE, DELETE-YOUR-OWN. No UPDATE path (a typo is deleted + reposted).
--     DELETE is your own message, or an admin tidying up (proofs.is_admin()).
--   * DENORMALISED AUTHOR. profiles is self-read-only under RLS, so the sender's
--     name/initials/colour are stamped onto the row by a SECURITY DEFINER BEFORE
--     INSERT trigger (same idiom as feedback_items_set_author, 000271).
--   * REALTIME. Unlike the feedback board (fetch-on-mount), a live chat needs
--     new messages to arrive without a refresh, so the table joins the
--     supabase_realtime publication. Verified live 2026-07-16: the publication
--     is per-table (puballtables = false) and the existing proofs entry is
--     schema-qualified (proofs.proof_version_views) — hence proofs.team_messages
--     below, NOT a bare name (which would resolve to public and never match).
--   * UNREAD BADGE. profiles.team_chat_seen_at (mirrors feedback_seen_at, 000281)
--     is the per-person "last opened the chat" marker; unread = messages newer
--     than it and not your own. Stamped to now() on every chat visit.

begin;

create table proofs.team_messages (
  id               uuid        primary key default gen_random_uuid(),
  -- Attribution: FK for the insert RLS check + delete-own; nullable so the row
  -- survives account removal (ON DELETE SET NULL), matching feedback_items.
  author_id        uuid        references proofs.profiles(id) on delete set null,
  -- Denormalised sender, for display on the shared channel (profiles is
  -- self-read-only, so these can't be joined back later).
  author_name      text,
  author_initials  text,
  author_colour    text,
  body             text        not null,
  created_at       timestamptz not null default now()
);

-- Oldest-first is how the channel renders, but we page newest-first from the
-- server (limit N, then reverse client-side), so index created_at desc.
create index team_messages_created_idx on proofs.team_messages (created_at desc);

alter table proofs.team_messages enable row level security;

-- Everyone signed in reads the whole channel.
create policy team_messages_select on proofs.team_messages
  for select to authenticated using (true);

-- Anyone signed in can post, but only as themselves.
create policy team_messages_insert on proofs.team_messages
  for insert to authenticated
  with check (author_id = auth.uid());

-- Delete your own message; an admin can remove anyone's.
create policy team_messages_delete on proofs.team_messages
  for delete to authenticated
  using (author_id = auth.uid() or proofs.is_admin());

-- Stamp the sender's display fields server-side (profiles is self-read-only, so
-- the shared channel can't join them back later). SECURITY DEFINER with a pinned
-- search_path; EXECUTE revoked from callers (a trigger fires regardless of
-- EXECUTE — the same hardening as 000182 / the feedback trigger).
create or replace function proofs.team_messages_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  select p.full_name, p.designer_initials, p.designer_colour
    into new.author_name, new.author_initials, new.author_colour
  from proofs.profiles p
  where p.id = new.author_id;
  return new;
end;
$$;

revoke execute on function proofs.team_messages_set_author() from public, anon, authenticated;
grant execute on function proofs.team_messages_set_author() to service_role;

create trigger team_messages_set_author
  before insert on proofs.team_messages
  for each row execute function proofs.team_messages_set_author();

-- Grant matrix — explicit because the proofs schema has NO default privileges.
-- No UPDATE grant: messages are immutable (delete + repost to fix a typo).
revoke all on proofs.team_messages from anon, public;
grant select, insert, delete on proofs.team_messages to authenticated;
grant all on proofs.team_messages to service_role;

-- Per-person "last opened the chat" marker for the header unread badge.
-- default now() backfills existing rows to apply-time (the first rollout doesn't
-- badge everyone with the whole history) and births new profiles "seen".
-- Inherits profiles' grants (authenticated already has UPDATE, 000176) and the
-- owner-update RLS (000171) only locks role / helpscout_user_id / deactivated_at,
-- so the owner writes this field freely — no grant or policy change needed.
alter table proofs.profiles
  add column if not exists team_chat_seen_at timestamptz default now();

comment on column proofs.profiles.team_chat_seen_at is
  'When this user last opened the team chat. Drives the header unread badge (messages newer than this, not authored by them). Stamped to now() on every chat visit; backfilled to apply time in 000319.';

-- Join the realtime publication so new messages arrive without a refresh.
-- Schema-qualified per the live check noted above; guarded for safe replay.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'proofs'
      and tablename = 'team_messages'
  ) then
    alter publication supabase_realtime add table proofs.team_messages;
  end if;
end $$;

commit;
