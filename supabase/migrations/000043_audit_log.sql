-- Migration 000043: audit_log table + logging helpers
--
-- First of two passes on the audit log. This one adds the table, the
-- access policies, and two SECURITY DEFINER RPCs so the frontend can log
-- without being given INSERT rights on the table itself. Prompt 2 will
-- add filters and a diff viewer.
--
-- Design decisions:
--   * audit_log is append-only (no UPDATE / DELETE policies). Service
--     role bypasses RLS for system inserts from edge functions; regular
--     writes go through the two RPCs which stamp actor_id from
--     auth.uid() so a designer can't spoof another user's activity.
--   * Two RPCs on purpose: log_audit_event takes zero actor args and
--     attributes the caller; log_customer_event is anon-callable and
--     takes an actor_email override because customers don't have a
--     Supabase session.
--   * actor_email / actor_label are denormalised snapshots so a later
--     email change or account deletion doesn't rewrite history.

begin;

create table audit_log (
  id            uuid        primary key default gen_random_uuid(),
  actor_id      uuid        references auth.users(id) on delete set null,
  actor_email   text,
  actor_label   text,
  action        text        not null,
  target_type   text,
  target_id     text,
  target_label  text,
  before_value  jsonb,
  after_value   jsonb,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_created_at_idx on audit_log (created_at desc);
create index audit_log_actor_id_idx   on audit_log (actor_id);
create index audit_log_action_idx     on audit_log (action);
create index audit_log_target_idx     on audit_log (target_type, target_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table audit_log enable row level security;

create policy "audit_log: admin read"
  on audit_log for select
  to authenticated
  using (is_admin());

-- No INSERT/UPDATE/DELETE policies — INSERT happens via the RPCs below
-- (SECURITY DEFINER) or via the service role from edge functions.

-- ── Logging helper: authenticated actor ──────────────────────────────────────

create or replace function log_audit_event(
  action        text,
  target_type   text       default null,
  target_id     text       default null,
  target_label  text       default null,
  before_value  jsonb      default null,
  after_value   jsonb      default null,
  metadata      jsonb      default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid;
  v_email    text;
  v_label    text;
  v_id       uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'log_audit_event requires an authenticated caller; use log_customer_event for anon actions';
  end if;

  select u.email::text, coalesce(p.full_name, u.email::text)
    into v_email, v_label
    from auth.users u
    left join public.profiles p on p.id = u.id
    where u.id = v_actor_id;

  insert into audit_log (
    actor_id, actor_email, actor_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  ) values (
    v_actor_id, v_email, v_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function log_audit_event(text, text, text, text, jsonb, jsonb, jsonb) to authenticated;

-- ── Logging helper: anon / customer-facing actions ───────────────────────────

create or replace function log_customer_event(
  action        text,
  target_type   text      default null,
  target_id     text      default null,
  target_label  text      default null,
  actor_email   text      default null,
  actor_label   text      default null,
  metadata      jsonb     default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into audit_log (
    actor_id, actor_email, actor_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  ) values (
    null,
    actor_email,
    coalesce(actor_label, 'customer'),
    action, target_type, target_id, target_label,
    null, null, metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function log_customer_event(text, text, text, text, text, text, jsonb) to anon, authenticated;

commit;
