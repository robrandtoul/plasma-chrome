-- Extend dashboard_latest_events to include customer-view rows.
--
-- Previously the view only surfaced proof_events (approvals + change
-- requests). Designers asked for "customer viewed" entries in the
-- right-hand sidebar so the feed reads as a single customer-activity
-- timeline, not just an action log.
--
-- Implementation: UNION ALL the existing event rows with deduplicated
-- non-bot rows from proof_version_views. Dedupe to one entry per
-- (proof_version_id, day) — the first view of that day — so a
-- customer refreshing the page ten times in five minutes still
-- produces a single feed entry. If they come back tomorrow, that's
-- a fresh row.
--
-- View-row shape mirrors the event-row shape so the dashboard renderer
-- doesn't need to branch heavily:
--   * id              — proof_version_views.id (uuid; namespace shared
--                       with proof_events.id but uuid collisions are
--                       astronomically unlikely)
--   * created_at      — viewed_at (alias keeps the ORDER BY clause
--                       uniform across both halves)
--   * event_type      — literal 'view'
--   * actor_name      — contact.full_name fallback to 'Customer'
--                       (views are anonymous; we use the project's
--                       contact as the implicit actor)
--   * recipient_name  — null
--   * helpscout_thread_id — null (no notification associated)
--
-- The proof_events.event_type CHECK constraint stays on the table
-- ('approve', 'request_changes'); 'view' only ever appears in the
-- view's output, never as a stored row.
--
-- RLS / grants unchanged: revoked from anon/PUBLIC, granted to
-- authenticated. proof_version_views.is_bot is the spam filter —
-- bots stay out of the feed.

begin;

create or replace view dashboard_latest_events as
  -- Customer action events (approve / request_changes)
  select
    e.id,
    e.created_at,
    e.event_type,
    e.actor_name,
    e.name                  as recipient_name,
    e.helpscout_thread_id,
    pv.id                   as proof_version_id,
    pv.version_number,
    p.id                    as proof_id,
    c.full_name             as contact_name,
    co.name                 as company_name
  from proof_events e
  join proof_versions pv on pv.id = e.proof_version_id
  join proofs p on p.id = pv.proof_id
  left join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id

  union all

  -- Customer view events (deduped to first view per version per day)
  select
    v.id,
    v.viewed_at                       as created_at,
    'view'::text                      as event_type,
    coalesce(c.full_name, 'Customer') as actor_name,
    null::text                        as recipient_name,
    null::text                        as helpscout_thread_id,
    pv.id                             as proof_version_id,
    pv.version_number,
    p.id                              as proof_id,
    c.full_name                       as contact_name,
    co.name                           as company_name
  from (
    select distinct on (proof_version_id, date_trunc('day', viewed_at))
      id, proof_version_id, viewed_at
    from proof_version_views
    where is_bot = false
    order by proof_version_id, date_trunc('day', viewed_at), viewed_at asc
  ) v
  join proof_versions pv on pv.id = v.proof_version_id
  join proofs p on p.id = pv.proof_id
  left join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

revoke all on dashboard_latest_events from anon, public;
grant select on dashboard_latest_events to authenticated;

commit;
