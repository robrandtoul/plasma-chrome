-- 000321: emoji reactions on team-chat messages.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration.
--
-- One row per (message, user, emoji). The reactor's name is denormalised
-- (profiles is self-read-only) so the shared channel can show a "who reacted"
-- tooltip. Joins the realtime publication so reactions appear/disappear live.

begin;

create table proofs.team_message_reactions (
  id          uuid        primary key default gen_random_uuid(),
  message_id  uuid        not null references proofs.team_messages(id) on delete cascade,
  user_id     uuid        not null references proofs.profiles(id) on delete cascade,
  user_name   text,
  emoji       text        not null,
  created_at  timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create index team_message_reactions_message_idx on proofs.team_message_reactions (message_id);

alter table proofs.team_message_reactions enable row level security;

-- Everyone signed in reads all reactions; you add / remove only your own.
create policy team_message_reactions_select on proofs.team_message_reactions
  for select to authenticated using (true);
create policy team_message_reactions_insert on proofs.team_message_reactions
  for insert to authenticated
  with check (user_id = auth.uid());
create policy team_message_reactions_delete on proofs.team_message_reactions
  for delete to authenticated
  using (user_id = auth.uid());

-- Stamp the reactor's name server-side.
create or replace function proofs.team_message_reactions_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  select p.full_name into new.user_name from proofs.profiles p where p.id = new.user_id;
  return new;
end;
$$;

revoke execute on function proofs.team_message_reactions_set_author() from public, anon, authenticated;
grant execute on function proofs.team_message_reactions_set_author() to service_role;

create trigger team_message_reactions_set_author
  before insert on proofs.team_message_reactions
  for each row execute function proofs.team_message_reactions_set_author();

-- Grant matrix — explicit (proofs schema has no default privileges). No UPDATE.
revoke all on proofs.team_message_reactions from anon, public;
grant select, insert, delete on proofs.team_message_reactions to authenticated;
grant all on proofs.team_message_reactions to service_role;

-- Live add/remove without a refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'proofs'
      and tablename = 'team_message_reactions'
  ) then
    alter publication supabase_realtime add table proofs.team_message_reactions;
  end if;
end $$;

commit;
