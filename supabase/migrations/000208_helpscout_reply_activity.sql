-- 000208_helpscout_reply_activity.sql
--
-- Inbound Help Scout reply-activity sync (see docs/helpscout-webhook-spec.md).
-- The helpscout-webhook edge function stamps a proof when a reply happens on its
-- linked Help Scout conversation; proofs_needing_attention() then suppresses the
-- four customer-chase rules for a grace window so a chase done in Help Scout
-- (which proof-viewer otherwise never sees) quiets the flag. Self-clearing: the
-- flag returns when the window lapses if the customer still hasn't acted.
--
-- Pieces:
--   1. Two timestamp columns on proofs (staff + customer reply).
--   2. helpscout_reply_grace_days in the needs_attention_rules setting (default 3).
--   3. proofs_needing_attention() — body verbatim from 000188 plus the grace
--      guard on the four chase rules (NOT request_changes_no_version, where the
--      fix is shipping a version, nor helpscout_follow_up_tag).
--   4. public_dashboard_projects — the 000198 definition with the two timestamps
--      appended (create-or-replace; grants + security_invoker re-stated).

begin;

-- ── 1. activity columns ───────────────────────────────────────────────────────

alter table proofs
  add column if not exists helpscout_last_reply_at timestamptz,
  add column if not exists helpscout_last_customer_reply_at timestamptz;

comment on column proofs.helpscout_last_reply_at is
  'Last outbound staff reply on the linked Help Scout conversation, stamped by '
  'the helpscout-webhook edge function. Suppresses the chase needs-attention '
  'rules for needs_attention_rules.helpscout_reply_grace_days.';
comment on column proofs.helpscout_last_customer_reply_at is
  'Last inbound customer reply on the linked Help Scout conversation. Also '
  'suppresses the chase rules (per the locked decision that customer replies '
  'count as activity).';

-- ── 2. grace-window setting (idempotent) ──────────────────────────────────────

update site_settings
  set needs_attention_rules =
    needs_attention_rules || jsonb_build_object('helpscout_reply_grace_days', 3)
  where id = 1
    and not (needs_attention_rules ? 'helpscout_reply_grace_days');

-- ── 3. rules engine: add the grace guard ──────────────────────────────────────

create or replace function proofs_needing_attention()
returns table (
  proof_id  uuid,
  rule_code text,
  rule_meta jsonb
)
language plpgsql
stable
set search_path = public
as $$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
  grace_days int;
begin
  select s.needs_attention_rules into rules from site_settings s where s.id = 1;

  rule_rcnv := rules->'request_changes_no_version';
  rule_hs   := rules->'helpscout_follow_up_tag';
  rule_snv  := rules->'sent_never_viewed';
  rule_vna  := rules->'viewed_not_actioned';
  rule_ad   := rules->'approaching_dormant';
  rule_sip  := rules->'stuck_in_progress';
  -- Grace window: a recent Help Scout reply (staff or customer) suppresses the
  -- chase rules for this many days. Defaults to 3 when the key is absent.
  grace_days := coalesce((rules->>'helpscout_reply_grace_days')::int, 3);

  return query
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  -- Rule 1: latest customer event on the current version is a
  -- request_changes, AND no version newer than that event has been
  -- shipped. Widened in 000188 to recognise designer_override_approve
  -- as a terminal workflow event.
  rcnv_evt as (
    select cv.proof_id, cv.created_at as version_created_at, e.created_at as event_at
    from current_versions cv
    join lateral (
      select pe.created_at, pe.event_type
      from proof_events pe
      where pe.proof_version_id = cv.version_id
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
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
  -- request_changes/designer_override_approve since the last view.
  -- Widened in 000188 so a designer override-approve clears the rule.
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
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
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
  -- Exclude proof+rule combinations with an active snooze.
  where not exists (
    select 1 from proof_attention_snoozes s
    where s.proof_id = f.proof_id
      and s.rule_code = f.rule_code
      and s.snoozed_until > now()
  )
  -- 000208: suppress the four customer-chase rules when there has been a recent
  -- Help Scout reply (staff or customer) on the linked conversation. Leaves
  -- request_changes_no_version (owe a version) and helpscout_follow_up_tag alone.
  and not (
    f.rule_code in ('sent_never_viewed', 'viewed_not_actioned', 'approaching_dormant', 'stuck_in_progress')
    and exists (
      select 1 from proofs p
      where p.id = f.proof_id
        and greatest(p.helpscout_last_reply_at, p.helpscout_last_customer_reply_at)
            >= now() - make_interval(days => grace_days)
    )
  )
  order by f.proof_id, f.priority asc, f.rule_code;
end;
$$;

comment on function proofs_needing_attention() is
  'Returns the highest-priority unfired needs-attention rule for each proof, '
  'excluding (proof_id, rule_code) pairs with an active snooze and (000208) '
  'suppressing the four chase rules when a Help Scout reply landed within '
  'needs_attention_rules.helpscout_reply_grace_days. Body otherwise verbatim '
  'from 000188.';

-- ── 4. expose the timestamps on the dashboard view ────────────────────────────
-- 000198 definition with helpscout_last_reply_at / helpscout_last_customer_reply_at
-- appended last (create-or-replace keeps existing columns/order). Grants and
-- security_invoker re-stated per the drop/replace discipline.

create or replace view public_dashboard_projects as
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
  latest_non_view_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_non_view_event_at,
      e.event_type    as latest_non_view_event_type
    from dashboard_latest_events e
    where e.event_type <> 'view'
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
    pr.avatar_url                                            as designer_avatar_url,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    snz.snooze_rule_code,
    snz.snoozed_until,
    snz.snooze_note,
    snz.snoozed_by_name,
    snz.snoozed_by_initials,
    snz.snoozed_by_colour,
    lne.latest_non_view_event_at,
    lne.latest_non_view_event_type,
    -- 000208: Help Scout reply activity, for the "Chased / Customer replied
    -- Nd ago" chip and as the source of the chase-rule suppression above.
    p.helpscout_last_reply_at,
    p.helpscout_last_customer_reply_at
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join latest_non_view_events lne on lne.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id
  left join na on na.proof_id = p.id
  left join lateral (
    select
      s.rule_code           as snooze_rule_code,
      s.snoozed_until,
      s.note                as snooze_note,
      pr2.full_name         as snoozed_by_name,
      pr2.designer_initials as snoozed_by_initials,
      pr2.designer_colour   as snoozed_by_colour
    from proof_attention_snoozes s
    left join profiles pr2 on pr2.id = s.snoozed_by
    where s.proof_id = p.id
      and s.snoozed_until > now() - interval '24 hours'
    order by s.snoozed_until desc
    limit 1
  ) snz on true;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;
alter view public_dashboard_projects set (security_invoker = on);

commit;
