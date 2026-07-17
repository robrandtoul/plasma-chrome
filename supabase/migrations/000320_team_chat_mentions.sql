-- 000320: @mentions in team chat + a push notification when you're mentioned.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration.
--
-- The chat is one shared room, so a plain "new message" push would be noisy.
-- Instead we only push when someone is @mentioned by name. The mentioned user
-- ids are stored explicitly on the row (picked from an autocomplete in the
-- composer) rather than parsed from text, so the push targets the exact people
-- the sender chose — no fuzzy name matching server-side.
--
-- Pieces:
--   1. team_messages.mentioned_user_ids — who this message @mentions.
--   2. Widen the notification_outbox source_kind CHECK to allow 'chat' (the
--      dedup ledger send-push writes to; unchanged otherwise).
--   3. Seed the 'team_chat_mention' copy into settings.notification_copy.
--   4. An AFTER INSERT trigger that fires send-push for the mentioned users
--      (excluding the author), gated on settings.push_enabled — same pattern and
--      auth (settings.push_internal_secret) as the customer-action push triggers
--      in 000284. Inert until send-push learns the 'team_chat_mention' event; an
--      un-updated send-push simply finds no recipients and no-ops.

begin;

-- 1. Who each message @mentions. Additive, inherits team_messages' grants.
alter table proofs.team_messages
  add column if not exists mentioned_user_ids uuid[] not null default '{}';

comment on column proofs.team_messages.mentioned_user_ids is
  'auth user ids @mentioned in this message (picked from the composer autocomplete). Drives the mention push in 000320.';

-- 2. Allow the 'chat' source kind in the push dedup ledger. Find + drop the
--    existing source_kind CHECK by its definition (name-agnostic) and re-add.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'proofs.notification_outbox'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%source_kind%';
  if v_name is not null then
    execute format('alter table proofs.notification_outbox drop constraint %I', v_name);
  end if;
end $$;

alter table proofs.notification_outbox
  add constraint notification_outbox_source_kind_check
  check (source_kind in ('proof_event', 'order', 'proof_finalize', 'condition', 'chat'));

-- 3. Copy for the mention push. Merge-in so the other event copy is untouched;
--    only sets it if not already present (idempotent replay).
update proofs.settings
  set notification_copy = coalesce(notification_copy, '{}'::jsonb) || jsonb_build_object(
    'team_chat_mention',
    jsonb_build_object('title', '{actor} mentioned you', 'body', '{snippet}')
  )
  where id = 1
    and not (coalesce(notification_copy, '{}'::jsonb) ? 'team_chat_mention');

-- 4. Fire send-push for the mentioned users. SECURITY DEFINER (reads the
--    admin-only settings secret), search_path pinned, EXECUTE revoked from
--    callers (triggers fire regardless — house pattern, 000182 / 000284).
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

revoke execute on function proofs.notify_push_on_chat_mention() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_chat_mention() to service_role;

drop trigger if exists notify_push_on_chat_mention on proofs.team_messages;
create trigger notify_push_on_chat_mention
  after insert on proofs.team_messages
  for each row execute function proofs.notify_push_on_chat_mention();

commit;
