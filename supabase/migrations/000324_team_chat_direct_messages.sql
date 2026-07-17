-- 000324: person-to-person direct messages in team chat.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration. Deploy the updated send-push edge
-- function FIRST (it gains the team_chat_dm branch and is inert until this
-- migration's trigger starts firing it), and the frontend only AFTER this is
-- applied (send() writes recipient_id on every DM).
--
-- Product decisions (Rob, 2026-07-17):
--   * PERSON-TO-PERSON ONLY. One optional recipient per message. NULL keeps
--     today's shared team room; set = private to that one person. No group
--     side-threads (that would be a heavier conversations model).
--   * TRULY PRIVATE. Only the two participants can read a DM — enforced by
--     RLS, so admins are excluded too. Realtime postgres_changes respects RLS,
--     so delivery is scoped the same way. recipient FK is ON DELETE CASCADE
--     (not SET NULL like author_id): a null recipient means "team room", so a
--     deleted recipient must take their private thread with them rather than
--     re-publishing it to everyone.
--   * PUSH ON EVERY DM. Unlike the shared room (mentions only, 000320), a DM
--     is by definition addressed to you, so each one pushes — respecting the
--     account-wide mute and an explicit team_chat_dm: off pref.

begin;

-- 1. The recipient. NULL = shared team room (all existing rows keep today's
--    behaviour untouched); set = private to that one person.
alter table proofs.team_messages
  add column if not exists recipient_id uuid references proofs.profiles(id) on delete cascade;

comment on column proofs.team_messages.recipient_id is
  'NULL = the shared team room; set = a direct message visible only to author + recipient (RLS-enforced, admins excluded). Added in 000324.';

create index if not exists team_messages_dm_idx
  on proofs.team_messages (recipient_id, created_at desc)
  where recipient_id is not null;

-- 2. Visibility: team rows to everyone signed in (unchanged); DM rows to the
--    two participants ONLY — no is_admin() escape hatch, per "truly private".
drop policy if exists team_messages_select on proofs.team_messages;
create policy team_messages_select on proofs.team_messages
  for select to authenticated
  using (
    recipient_id is null
    or author_id = auth.uid()
    or recipient_id = auth.uid()
  );

-- Post as yourself; no DM-to-self.
drop policy if exists team_messages_insert on proofs.team_messages;
create policy team_messages_insert on proofs.team_messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (recipient_id is null or recipient_id <> auth.uid())
  );

-- DELETE policy deliberately unchanged (own-or-admin): an admin removing a DM
-- row they cannot read is blind tidying, needed for account cleanup — it never
-- reveals content.

-- 3. Reactions inherit message visibility. The 000321 read-all policy would
--    otherwise leak that a private thread exists (message ids + reactor names)
--    and let a third party react onto a message they can't see.
drop policy if exists team_message_reactions_select on proofs.team_message_reactions;
create policy team_message_reactions_select on proofs.team_message_reactions
  for select to authenticated
  using (
    exists (
      select 1 from proofs.team_messages m
      where m.id = message_id
        and (m.recipient_id is null or m.author_id = auth.uid() or m.recipient_id = auth.uid())
    )
  );

drop policy if exists team_message_reactions_insert on proofs.team_message_reactions;
create policy team_message_reactions_insert on proofs.team_message_reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from proofs.team_messages m
      where m.id = message_id
        and (m.recipient_id is null or m.author_id = auth.uid() or m.recipient_id = auth.uid())
    )
  );

-- 4. Per-thread "last read" stamps for the DM unread badges. One row per
--    (reader, peer); the shared room keeps profiles.team_chat_seen_at.
create table proofs.team_chat_dm_reads (
  user_id  uuid        not null references proofs.profiles(id) on delete cascade,
  peer_id  uuid        not null references proofs.profiles(id) on delete cascade,
  seen_at  timestamptz not null default now(),
  primary key (user_id, peer_id)
);

alter table proofs.team_chat_dm_reads enable row level security;

create policy team_chat_dm_reads_select on proofs.team_chat_dm_reads
  for select to authenticated using (user_id = auth.uid());
create policy team_chat_dm_reads_insert on proofs.team_chat_dm_reads
  for insert to authenticated with check (user_id = auth.uid());
create policy team_chat_dm_reads_update on proofs.team_chat_dm_reads
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Grant matrix — explicit (proofs schema has no default privileges). UPDATE is
-- needed for the upsert; no DELETE (stamps only ever move forward).
revoke all on proofs.team_chat_dm_reads from anon, public;
grant select, insert, update on proofs.team_chat_dm_reads to authenticated;
grant all on proofs.team_chat_dm_reads to service_role;

-- 5. Copy for the DM push (merge-in, idempotent — 000320 pattern).
update proofs.settings
  set notification_copy = coalesce(notification_copy, '{}'::jsonb) || jsonb_build_object(
    'team_chat_dm',
    jsonb_build_object('title', '{actor} sent you a message', 'body', '{snippet}')
  )
  where id = 1
    and not (coalesce(notification_copy, '{}'::jsonb) ? 'team_chat_dm');

-- 6. Push on every DM. Same shape/auth as notify_push_on_chat_mention (000320):
--    SECURITY DEFINER (reads the admin-only settings secret), pinned
--    search_path, EXECUTE revoked from callers (triggers fire regardless).
create or replace function proofs.notify_push_on_chat_dm()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
  -- Team-room rows (or a malformed self-DM) → nothing to do.
  if new.recipient_id is null or new.recipient_id = new.author_id then
    return new;
  end if;

  select push_enabled, push_internal_secret
    into v_enabled, v_secret
  from proofs.settings where id = 1;

  if not coalesce(v_enabled, false) or v_secret is null then
    return new;  -- kill switch off → stay inert
  end if;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'event_code', 'team_chat_dm',
      'source_kind', 'chat',
      'source_event_id', new.id::text,
      'actor_user_id', new.author_id,
      'recipient_user_ids', to_jsonb(array[new.recipient_id]),
      'vars', jsonb_build_object(
        'actor', coalesce(new.author_name, 'Someone'),
        -- Image-only DMs have an empty body; say so rather than pushing blank.
        'snippet', case when length(btrim(coalesce(new.body, ''))) > 0
                        then left(new.body, 140)
                        else 'Sent an attachment' end
      )
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_chat_dm() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_chat_dm() to service_role;

drop trigger if exists notify_push_on_chat_dm on proofs.team_messages;
create trigger notify_push_on_chat_dm
  after insert on proofs.team_messages
  for each row execute function proofs.notify_push_on_chat_dm();

-- 7. Suppress the MENTION push on DM rows. The composer never sends mentions
--    on a DM, but a crafted REST insert could otherwise attach a third party's
--    id to a private message and leak its snippet to them via push. Body is
--    the 000320 function verbatim plus the one early return.
create or replace function proofs.notify_push_on_chat_mention()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled    boolean;
  v_secret     text;
  v_recipients uuid[];
begin
  -- Private rows never fire the mention push — the DM push (000324) covers
  -- the recipient, and nobody else may learn the row exists.
  if new.recipient_id is not null then
    return new;
  end if;

  -- No mentions → nothing to do.
  if new.mentioned_user_ids is null or array_length(new.mentioned_user_ids, 1) is null then
    return new;
  end if;

  select push_enabled, push_internal_secret
    into v_enabled, v_secret
  from proofs.settings where id = 1;

  if not coalesce(v_enabled, false) or v_secret is null then
    return new;  -- kill switch off → stay inert
  end if;

  -- Distinct mentioned users, minus the author (you don't ping yourself).
  select array_agg(distinct u)
    into v_recipients
  from unnest(new.mentioned_user_ids) as u
  where u is distinct from new.author_id;

  if v_recipients is null or array_length(v_recipients, 1) is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'event_code', 'team_chat_mention',
      'source_kind', 'chat',
      'source_event_id', new.id::text,
      'actor_user_id', new.author_id,
      'recipient_user_ids', to_jsonb(v_recipients),
      'vars', jsonb_build_object(
        'actor', coalesce(new.author_name, 'Someone'),
        'snippet', left(new.body, 140)
      )
    )
  );
  return new;
end;
$$;

commit;
