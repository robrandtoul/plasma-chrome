-- Migration 000154: configurable Needs-attention rules engine.
--
-- Phase 2a's brief replaces 000152's two hard-coded rules with a JSONB-
-- configured engine of six. Configuration lives on site_settings; the
-- evaluator is a SQL/plpgsql function that returns one row per
-- flagged proof along with the highest-priority rule that fired and a
-- bag of metadata for the dashboard chip.
--
-- Five things land here:
--
--   1. site_settings.needs_attention_rules JSONB
--      Holds the per-rule enabled / threshold_days / calendar /
--      priority values. Default seeds all six rules in priority
--      order with sensible thresholds.
--
--   2. proofs.helpscout_tags text[] (default '{}')
--      Denormalised mirror of the tags on the linked Help Scout
--      conversation. Phase 2b will wire HS → DB sync; for now the
--      column is present so the helpscout_follow_up_tag rule has
--      something to read against. The rule is enabled by default
--      regardless — until the sync ships, the array is empty for
--      every proof and the rule just doesn't fire.
--
--   3. business_days_between(d1 date, d2 date) → int
--      Counts weekdays (Mon–Fri) strictly between two dates. Bank
--      holidays are not honoured — explicitly out of scope. Used by
--      every rule that has calendar=false.
--
--   4. proofs_needing_attention() → table(proof_id uuid, rule_code
--      text, rule_meta jsonb)
--      Was returning uuid[] (000152). Replaced with a per-rule
--      shape so the dashboard can render reason chips. Returns the
--      single highest-priority rule per proof — proofs that match
--      multiple rules collapse to one row, picked by the lowest
--      priority value (1 > 2 > … > 6 by the seeded defaults).
--
--      rule_meta carries a `{"days": N}` field for any rule with a
--      threshold, so the frontend can template "Sent {N} working
--      days ago, never opened" without re-deriving N.
--
--   5. public_dashboard_projects view extended with rule_code +
--      rule_meta columns. dashboard_tile_counts() updated to count
--      rows from the new function shape.
--
-- Audit log behaviour: site_settings updates from the rules editor
-- are logged client-side via the existing logAudit() helper from
-- src/lib/audit.ts (action: 'setting.needs_attention_rules_updated'),
-- matching the pattern used in AdminSettingsPage. No server-side
-- trigger — the existing pattern keeps audit responsibility on the
-- mutating page so before/after diffs are captured cleanly.

begin;

-- ── 1. site_settings.needs_attention_rules ──────────────────────────────────

alter table site_settings
  add column if not exists needs_attention_rules jsonb not null default jsonb_build_object(
    'request_changes_no_version', jsonb_build_object('enabled', true,  'threshold_days', 2,  'calendar', false, 'priority', 1),
    'helpscout_follow_up_tag',    jsonb_build_object('enabled', true,                                              'priority', 2),
    'sent_never_viewed',          jsonb_build_object('enabled', true,  'threshold_days', 3,  'calendar', false, 'priority', 3),
    'viewed_not_actioned',        jsonb_build_object('enabled', true,  'threshold_days', 5,  'calendar', false, 'priority', 4),
    'approaching_dormant',        jsonb_build_object('enabled', true,  'threshold_days', 5,  'calendar', true,  'priority', 5),
    'stuck_in_progress',          jsonb_build_object('enabled', true,  'threshold_days', 10, 'calendar', false, 'priority', 6)
  );

comment on column site_settings.needs_attention_rules is
  'JSONB map of rule_code → {enabled, threshold_days?, calendar?, '
  'priority}. Drives proofs_needing_attention(); admin editor at '
  '/admin/needs-attention writes here.';

-- ── 2. proofs.helpscout_tags ────────────────────────────────────────────────

alter table proofs
  add column if not exists helpscout_tags text[] not null default '{}';

comment on column proofs.helpscout_tags is
  'Denormalised mirror of the tags on the linked Help Scout '
  'conversation. Phase 2b will wire HS → DB sync. Empty array '
  'until then; the helpscout_follow_up_tag needs-attention rule '
  'reads from this column.';

-- ── 3. business_days_between(d1, d2) ────────────────────────────────────────

create or replace function business_days_between(d1 date, d2 date)
returns int
language sql
immutable
as $$
  -- Strictly between: neither endpoint counted. Mon → Fri returns 3
  -- (Tue, Wed, Thu). Same day returns 0. Reverse-order args return
  -- the same as the forward order via least/greatest.
  select coalesce(count(*), 0)::int
  from generate_series(
    least(d1, d2) + 1,
    greatest(d1, d2) - 1,
    interval '1 day'
  ) g(d)
  where extract(dow from d) not in (0, 6);
$$;

comment on function business_days_between(date, date) is
  'Counts weekdays (Mon–Fri) strictly between two dates. Bank '
  'holidays are not honoured — out of scope for Phase 2a. Used '
  'by proofs_needing_attention() for any rule with calendar=false.';

-- ── 4. proofs_needing_attention() ───────────────────────────────────────────
--
-- Function signature changed (uuid[] → table). DROP first because
-- CREATE OR REPLACE can't change the return shape. Postgres function-
-- to-function references resolve at call time, not at definition
-- time, so dashboard_tile_counts() doesn't need a CASCADE here.

drop function if exists proofs_needing_attention();

create or replace function proofs_needing_attention()
returns table (
  proof_id  uuid,
  rule_code text,
  rule_meta jsonb
)
language plpgsql
stable
as $$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
begin
  select s.needs_attention_rules into rules from site_settings s where s.id = 1;

  rule_rcnv := rules->'request_changes_no_version';
  rule_hs   := rules->'helpscout_follow_up_tag';
  rule_snv  := rules->'sent_never_viewed';
  rule_vna  := rules->'viewed_not_actioned';
  rule_ad   := rules->'approaching_dormant';
  rule_sip  := rules->'stuck_in_progress';

  return query
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  -- Rule 1: latest customer event on the current version is a
  -- request_changes, AND no version newer than that event has been
  -- shipped.
  rcnv_evt as (
    select cv.proof_id, cv.created_at as version_created_at, e.created_at as event_at
    from current_versions cv
    join lateral (
      select pe.created_at, pe.event_type
      from proof_events pe
      where pe.proof_version_id = cv.version_id
        and pe.event_type in ('approve', 'request_changes')
      order by pe.created_at desc
      limit 1
    ) e on true
    where e.event_type = 'request_changes'
      and not exists (
        select 1 from proof_versions newer
        where newer.proof_id = cv.proof_id
          and newer.created_at > e.created_at
      )
  ),
  rcnv as (
    select
      r.proof_id,
      case when (rule_rcnv->>'calendar')::boolean
        then (extract(epoch from now() - r.event_at)::int) / 86400
        else business_days_between(r.event_at::date, now()::date)
      end as days
    from rcnv_evt r
  ),
  -- Rule 2: HS follow-up tag (no threshold).
  hs as (
    select p.id as proof_id
    from proofs p
    where p.helpscout_conversation_id is not null
      and p.helpscout_tags @> array['follow up']::text[]
  ),
  -- Rule 3: in_progress, no non-bot view of the current version.
  snv as (
    select cv.proof_id,
      case when (rule_snv->>'calendar')::boolean
        then (extract(epoch from now() - cv.created_at)::int) / 86400
        else business_days_between(cv.created_at::date, now()::date)
      end as days
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    where p.status = 'in_progress'
      and not exists (
        select 1 from proof_version_views v
        where v.proof_version_id = cv.version_id and v.is_bot = false
      )
  ),
  -- Rule 4: in_progress, current version was viewed but no approve/
  -- request_changes since the last view.
  vna_seed as (
    select cv.proof_id, cv.version_id, max(v.viewed_at) as last_viewed_at
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join proof_version_views v on v.proof_version_id = cv.version_id and v.is_bot = false
    where p.status = 'in_progress'
    group by cv.proof_id, cv.version_id
  ),
  vna as (
    select s.proof_id,
      case when (rule_vna->>'calendar')::boolean
        then (extract(epoch from now() - s.last_viewed_at)::int) / 86400
        else business_days_between(s.last_viewed_at::date, now()::date)
      end as days
    from vna_seed s
    where not exists (
      select 1 from proof_events pe
      where pe.proof_version_id = s.version_id
        and pe.event_type in ('approve', 'request_changes')
        and pe.created_at >= s.last_viewed_at
    )
  ),
  -- Rule 5: approaching dormant (calendar days only). Fires when
  -- last_activity_at is in the (30 - threshold, 30) days-ago band.
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (30 - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - interval '30 days'
  ),
  -- Rule 6: stuck in progress — in_progress with no event or view in
  -- threshold working/calendar days.
  sip as (
    select p.id as proof_id,
      case when (rule_sip->>'calendar')::boolean
        then (extract(epoch from now() - p.last_activity_at)::int) / 86400
        else business_days_between(p.last_activity_at::date, now()::date)
      end as days
    from proofs p
    where p.status = 'in_progress'
      and not exists (
        select 1 from proof_events pe
        join proof_versions pv on pv.id = pe.proof_version_id
        where pv.proof_id = p.id
          and pe.created_at >= now() - make_interval(days => (rule_sip->>'threshold_days')::int)
      )
      and not exists (
        select 1 from proof_version_views v
        join proof_versions pv on pv.id = v.proof_version_id
        where pv.proof_id = p.id
          and v.is_bot = false
          and v.viewed_at >= now() - make_interval(days => (rule_sip->>'threshold_days')::int)
      )
  ),
  flagged as (
    select rcnv.proof_id, 'request_changes_no_version'::text as rule_code,
      jsonb_build_object('days', rcnv.days) as rule_meta,
      (rule_rcnv->>'priority')::int as priority
    from rcnv
    where (rule_rcnv->>'enabled')::boolean
      and rcnv.days >= (rule_rcnv->>'threshold_days')::int

    union all
    select hs.proof_id, 'helpscout_follow_up_tag'::text,
      '{}'::jsonb,
      (rule_hs->>'priority')::int
    from hs
    where (rule_hs->>'enabled')::boolean

    union all
    select snv.proof_id, 'sent_never_viewed'::text,
      jsonb_build_object('days', snv.days),
      (rule_snv->>'priority')::int
    from snv
    where (rule_snv->>'enabled')::boolean
      and snv.days >= (rule_snv->>'threshold_days')::int

    union all
    select vna.proof_id, 'viewed_not_actioned'::text,
      jsonb_build_object('days', vna.days),
      (rule_vna->>'priority')::int
    from vna
    where (rule_vna->>'enabled')::boolean
      and vna.days >= (rule_vna->>'threshold_days')::int

    union all
    select ad.proof_id, 'approaching_dormant'::text,
      jsonb_build_object('days', ad.days),
      (rule_ad->>'priority')::int
    from ad
    where (rule_ad->>'enabled')::boolean

    union all
    select sip.proof_id, 'stuck_in_progress'::text,
      jsonb_build_object('days', sip.days),
      (rule_sip->>'priority')::int
    from sip
    where (rule_sip->>'enabled')::boolean
      and sip.days >= (rule_sip->>'threshold_days')::int
  )
  select distinct on (f.proof_id) f.proof_id, f.rule_code, f.rule_meta
  from flagged f
  -- Lowest priority value wins. Tie-break on rule_code so the
  -- result is deterministic across calls.
  order by f.proof_id, f.priority asc, f.rule_code;
end;
$$;

grant execute on function proofs_needing_attention() to authenticated;

comment on function proofs_needing_attention() is
  'Phase 2a rules-engine evaluator. Reads site_settings.'
  'needs_attention_rules and returns one row per flagged proof, '
  'carrying the highest-priority rule that matched plus a metadata '
  'bag for chip rendering. Replaced the 000152 uuid[] returner.';

-- ── 5. public_dashboard_projects view ───────────────────────────────────────
--
-- Drop and recreate to add rule_code + rule_meta columns. Postgres
-- doesn't support adding columns to existing views in arbitrary
-- positions, so a full rewrite is the only path.

drop view if exists public_dashboard_projects;

create view public_dashboard_projects as
  with current_versions as (
    select distinct on (pv.proof_id)
      pv.proof_id,
      pv.id              as version_id,
      pv.version_number,
      pv.material_display,
      pv.created_at      as version_created_at,
      pv.created_by      as designer_user_id
    from proof_versions pv
    where pv.is_current
    order by pv.proof_id, pv.version_number desc
  ),
  latest_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_event_at,
      e.event_type    as latest_event_type,
      e.actor_name    as latest_event_actor
    from dashboard_latest_events e
    order by e.proof_id, e.created_at desc
  ),
  current_view_state as (
    select distinct on (cv.proof_id)
      cv.proof_id,
      v.viewed_at as current_version_viewed_at
    from proof_versions cv
    join proof_version_views v on v.proof_version_id = cv.id
    where cv.is_current and v.is_bot = false
    order by cv.proof_id, v.viewed_at desc
  ),
  na as (
    select * from proofs_needing_attention()
  )
  select
    p.id                                                     as proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id                                                     as contact_id,
    c.full_name                                              as contact_name,
    c.email                                                  as contact_email,
    co.id                                                    as company_id,
    co.name                                                  as company_name,
    cv.version_id                                            as current_version_id,
    cv.version_number                                        as current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name                                             as designer_name,
    pr.designer_initials,
    pr.designer_colour,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id
  left join na on na.proof_id = p.id;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles), the latest dashboard_latest_events row, and the '
  'highest-priority needs-attention rule from '
  'proofs_needing_attention(). View runs as owner so it bypasses '
  'admin-only RLS on profiles for the avatar metadata.';

-- ── 6. dashboard_tile_counts() ──────────────────────────────────────────────
--
-- Same shape as 000152's; just re-emits the count() roll-up against
-- the new table-returning proofs_needing_attention().

create or replace function dashboard_tile_counts()
returns table (
  needs_attention    int,
  awaiting_customer  int,
  dormant            int,
  approved_this_week int
)
language sql
stable
as $$
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  awaiting as (
    select cv.proof_id
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    where p.status = 'in_progress'
      and not exists (
        select 1
        from proof_version_views v
        where v.proof_version_id = cv.version_id
          and v.is_bot = false
      )
      and not exists (
        select 1
        from proof_events e
        where e.proof_version_id = cv.version_id
          and e.event_type in ('approve', 'request_changes')
      )
  )
  select
    (select count(*)::int from proofs_needing_attention())   as needs_attention,
    (select count(*)::int from awaiting)                     as awaiting_customer,
    (select count(*)::int from proofs where status = 'dormant') as dormant,
    (select count(*)::int from proofs
       where status = 'approved'
         and approved_at >= now() - interval '7 days')        as approved_this_week;
$$;

grant execute on function dashboard_tile_counts() to authenticated;

commit;
