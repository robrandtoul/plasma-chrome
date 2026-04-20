-- Migration 000044: search indexes + actor listing for the audit log
--
-- Phase-2 bits for the activity page:
--   * Trigram GIN indexes on the two text columns search hits, so ILIKE
--     '%...%' on actor_email / target_label stops being a sequential
--     scan once the table grows past a few thousand rows.
--   * list_audit_actors() — a small SECURITY INVOKER helper that returns
--     one row per distinct actor with their latest label, for the
--     filter bar's Actor dropdown. Runs under the caller's privileges,
--     so the admin RLS policy still gates access.

begin;

create extension if not exists pg_trgm;

create index if not exists audit_log_actor_email_trgm
  on audit_log using gin (actor_email gin_trgm_ops);

create index if not exists audit_log_target_label_trgm
  on audit_log using gin (target_label gin_trgm_ops);

create or replace function list_audit_actors()
returns table (
  actor_id    uuid,
  actor_email text,
  actor_label text,
  last_seen   timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (actor_id)
    actor_id,
    actor_email,
    actor_label,
    created_at as last_seen
  from audit_log
  where actor_id is not null
  order by actor_id, created_at desc
$$;

grant execute on function list_audit_actors() to authenticated;

commit;
