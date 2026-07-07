-- 000307_nudges_exhausted_wait_one_interval.sql
--
-- Hold a fully-reminded proof for one reminder-interval BEFORE it escalates to
-- Needs attention, instead of dropping in the instant the last reminder is sent.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push — the CLI link points at the
-- retired standalone project.
--
-- Background
-- ----------
-- The automation sends up to `max_nudges` reminders (live: 4) at `repeat_days`
-- working-day spacing (live: 3). The moment the last reminder is sent the proof
-- was landing straight in Needs attention via the `nudges_exhausted` rule.
--
-- There was MEANT to be a pause: `nudges_exhausted` is one of the rules the
-- 000208 Help Scout grace window suppresses, and the design assumed the final
-- reminder self-stamps `helpscout_last_reply_at` (giving ~grace_days of quiet
-- before the escalation). But reminders #2+ open a FRESH Help Scout
-- conversation (send-nudges spec §6, the deliverability lever). A created
-- conversation fires `convo.created`, which the webhook does NOT treat as a
-- reply, so it never stamps `helpscout_last_reply_at`. The stamp stays frozen
-- at reminder #1's time — ~13 days stale by reminder #4 on live data — so the
-- grace window is always already expired and the escalation is not delayed at
-- all.
--
-- Fix (Rob's call, 2026-07-07): stop relying on the Help Scout reply signal.
-- Measure the wait from the reminder ledger itself (always reliable), using the
-- rule's own `repeat_days`. After the last reminder the proof gets one more
-- interval — the same window the customer had between reminders — to react.
-- During that wait it STAYS in the "In follow-up" tile (the automation is not
-- finished with it); only once the interval lapses without a response does it
-- move to Needs attention as `nudges_exhausted`.
--
-- Two CREATE OR REPLACE changes, both keeping their exact signatures so grants,
-- search_path, and the public_dashboard_projects / dashboard_list dependents
-- survive untouched. Bodies are verbatim from the LIVE definitions (verified via
-- pg_get_functiondef, not the migration files — the live
-- proofs_needing_attention() request_changes_no_version rule already reads from
-- proof_name_approvals, a change not itemised in any single file) apart from the
-- marked additions.
--
--  1. proofs_in_follow_up() — add Branch C: a proof whose per-version reminder
--     cap is spent but whose last reminder went out LESS than `repeat_days`
--     working days ago is still "in follow-up" (waiting out the final interval).
--     Because proofs_needing_attention() suppresses the raw chase rule for
--     anything in this set (the 000246 S3 guard), and the view derives
--     follow_up_* from here, the proof stays visible under In-follow-up with the
--     honest "Reminder N of N" label during the wait — no frontend change.
--
--  2. proofs_needing_attention() — the `exhausted` CTE only produces its row
--     once `business_days_between(last reminder, today) >= repeat_days`. Below
--     that it stays silent, so `nudges_exhausted` does not fire during the wait.
--     cap_counts gains `last_sent_at` (the newest counted reminder) to drive it.
--
-- The two guards are exact complements at any instant: while
-- business_days_between(last_sent, now) < repeat_days the proof is in Branch C
-- (raw chase suppressed by S3, no exhausted row); once it reaches >= repeat_days
-- Branch C releases it and the exhausted row appears (raw chase suppressed by
-- S4, nudges_exhausted fires). There is no gap where the raw "never opened" /
-- "not actioned" reason could leak back into Needs attention.
--
-- Working days (business_days_between) match the sender's repeat_days cooldown
-- convention and every other threshold in this function. If nudges_exhausted is
-- disabled the exhausted row never appears, so after the wait the raw chase
-- surfaces instead — a cap-spent proof is never stranded.

begin;

-- ── 1. proofs_in_follow_up(): keep the proof in-flight for the final interval ─
create or replace function proofs.proofs_in_follow_up()
returns table(proof_id uuid, rule_code text, sent_count integer, max_nudges integer, last_sent_at timestamp with time zone)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with rules as (
    select coalesce(
      (select needs_attention_rules from site_settings where id = 1),
      '{}'::jsonb
    ) as r
  ),
  automation as (
    select coalesce((select r->'automation' from rules), '{}'::jsonb) as a
  ),
  current_versions as (
    select pv.proof_id, pv.id as version_id
    from proof_versions pv
    join proofs p on p.id = pv.proof_id
    where pv.is_current and p.status = 'in_progress'
  ),
  nudge_usage as (
    select n.proof_id, n.rule_code,
      count(*) filter (where n.state in ('sending','sent'))::int as sent_count,
      max(n.created_at) filter (where n.state in ('sending','sent')) as last_sent_at
    from proof_nudges n
    join current_versions cv
      on cv.proof_id = n.proof_id and cv.version_id = n.proof_version_id
    where n.rule_code in ('sent_never_viewed','viewed_not_actioned')
    group by n.proof_id, n.rule_code
  ),
  -- Branch A: already chasing — at least one reminder sent on the current
  -- version, cap not yet spent, rule in auto mode. (Unchanged from 000246.)
  branch_a as (
    select u.proof_id, u.rule_code, u.sent_count,
      coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2) as max_nudges,
      u.last_sent_at
    from nudge_usage u
    where u.sent_count >= 1
      and u.sent_count < coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2)
      and coalesce((select (a->u.rule_code->>'mode') from automation), 'review') = 'auto'
  ),
  -- Branch B: pending its first send — a live auto-nudge candidate the sender
  -- will act on but has not yet. Mirrors decideForProof()'s pre-send guards.
  branch_b as (
    select
      c.proof_id,
      c.rule_code,
      coalesce(u.sent_count, 0) as sent_count,
      coalesce((automation.a->c.rule_code->>'max_nudges')::int, 2) as max_nudges,
      u.last_sent_at
    from compute_nudge_candidates() c
    cross join rules
    cross join automation
    left join nudge_usage u
      on u.proof_id = c.proof_id and u.rule_code = c.rule_code
    where
      coalesce((rules.r->c.rule_code->>'enabled')::boolean, false)
      and coalesce((automation.a->c.rule_code->>'mode'), 'review') = 'auto'
      and c.anchor_at is not null
      and not c.auto_nudge_disabled
      and not c.has_followup_tag
      and not c.snoozed
      and not (
        c.last_customer_reply_at is not null
        and c.last_customer_reply_at > greatest(
          coalesce(c.send_evidence_at, 'epoch'::timestamptz),
          coalesce(c.last_staff_reply_at, 'epoch'::timestamptz),
          coalesce(u.last_sent_at, 'epoch'::timestamptz)
        )
      )
      and coalesce(u.sent_count, 0) < coalesce((automation.a->c.rule_code->>'max_nudges')::int, 2)
      and (
        case
          when c.rule_code = 'sent_never_viewed' then
            case when coalesce((rules.r->'sent_never_viewed'->>'calendar')::boolean, false)
              then (extract(epoch from now() - c.version_created_at)::int) / 86400
              else business_days_between(c.version_created_at::date, now()::date)
            end
          else
            case when coalesce((rules.r->'viewed_not_actioned'->>'calendar')::boolean, false)
              then (extract(epoch from now() - c.anchor_at)::int) / 86400
              else business_days_between(c.anchor_at::date, now()::date)
            end
        end
      ) >= coalesce((rules.r->c.rule_code->>'threshold_days')::int, 0)
  ),
  -- Branch C (000307): cap spent, but the last reminder went out LESS than
  -- repeat_days working days ago. The automation has finished sending but is
  -- still waiting out one interval for the customer to react to the FINAL
  -- reminder — so the proof is still the automation's job, not a human's. Once
  -- the interval lapses this stops matching and nudges_exhausted takes over
  -- (proofs_needing_attention). Only the two auto-send rules reach nudge_usage,
  -- so this is scoped to them by construction.
  branch_c as (
    select u.proof_id, u.rule_code, u.sent_count,
      coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2) as max_nudges,
      u.last_sent_at
    from nudge_usage u
    where u.sent_count >= coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2)
      and coalesce((select (a->u.rule_code->>'mode') from automation), 'review') = 'auto'
      and u.last_sent_at is not null
      and business_days_between(u.last_sent_at::date, now()::date)
          < coalesce((select (a->u.rule_code->>'repeat_days')::int from automation), 3)
  )
  -- One row per proof. Branch C (sent_count = cap) sorts above a Branch A/B row
  -- for the same proof, but in practice the three branches are cap-disjoint so
  -- they never collide.
  select distinct on (x.proof_id)
    x.proof_id, x.rule_code, x.sent_count, x.max_nudges, x.last_sent_at
  from (
    select * from branch_a
    union all
    select * from branch_b
    union all
    select * from branch_c
  ) x
  order by x.proof_id, x.sent_count desc, x.last_sent_at desc nulls last;
$function$;

revoke execute on function proofs.proofs_in_follow_up() from anon, public;
grant execute on function proofs.proofs_in_follow_up() to authenticated;

-- ── 2. proofs_needing_attention(): delay the exhausted row by one interval ────
-- Byte-identical to the LIVE definition except: cap_counts gains last_sent_at,
-- and the exhausted CTE adds the repeat_days interval guard (both marked).
create or replace function proofs.proofs_needing_attention()
returns table(proof_id uuid, rule_code text, rule_meta jsonb)
language plpgsql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
  rule_aev  jsonb;
  rule_nex  jsonb;
  rule_ano  jsonb;
  automation jsonb;
  grace_days int;
  dormancy_cutoff int;
begin
  select s.needs_attention_rules, coalesce(s.dormancy_threshold_days, 90)
    into rules, dormancy_cutoff
    from site_settings s where s.id = 1;

  rule_rcnv := rules->'request_changes_no_version';
  rule_hs   := rules->'helpscout_follow_up_tag';
  rule_snv  := rules->'sent_never_viewed';
  rule_vna  := rules->'viewed_not_actioned';
  rule_ad   := rules->'approaching_dormant';
  rule_sip  := rules->'stuck_in_progress';
  rule_aev  := rules->'approved_earlier_version';
  rule_nex  := rules->'nudges_exhausted';
  rule_ano  := rules->'approved_no_order';
  automation := coalesce(rules->'automation', '{}'::jsonb);
  grace_days := coalesce((rules->>'helpscout_reply_grace_days')::int, 3);

  return query
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  rcnv_evt as (
    select cv.proof_id, cv.created_at as version_created_at, a.last_request_at as event_at
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join lateral (
      select max(pna.updated_at) as last_request_at
      from proof_name_approvals pna
      where pna.proof_version_id = cv.version_id
        and pna.state = 'changes_requested'
    ) a on a.last_request_at is not null
    where p.status not in ('approved', 'abandoned')
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
  hs as (
    select p.id as proof_id
    from proofs p
    where p.helpscout_conversation_id is not null
      and p.helpscout_tags @> array['follow up']::text[]
  ),
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
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (dormancy_cutoff - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - make_interval(days => dormancy_cutoff)
  ),
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
  aev as (
    select cv.proof_id,
      max(old_pv.version_number) as approved_version
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join proof_versions old_pv
      on old_pv.proof_id = cv.proof_id
     and old_pv.id <> cv.version_id
    join proof_name_approvals a
      on a.proof_version_id = old_pv.id
     and a.state = 'approved'
    where p.status not in ('approved', 'abandoned')
      and not exists (
        select 1 from proof_name_approvals ca
        where ca.proof_version_id = cv.version_id
          and ca.state = 'approved'
          and ca.name = a.name
      )
    group by cv.proof_id
  ),
  ano as (
    select p.id as proof_id,
      case when (rule_ano->>'calendar')::boolean
        then (extract(epoch from now() - p.approved_at)::int) / 86400
        else business_days_between(p.approved_at::date, now()::date)
      end as days
    from proofs p
    where p.status = 'approved'
      and p.approved_at is not null
      and not exists (
        select 1 from orders o
        where o.proof_id = p.id
          and o.status in ('sent', 'paid', 'fulfilled', 'revision')
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

    union all
    select aev.proof_id, 'approved_earlier_version'::text,
      jsonb_build_object('version', aev.approved_version),
      (rule_aev->>'priority')::int
    from aev
    where coalesce((rule_aev->>'enabled')::boolean, false)

    union all
    select ano.proof_id, 'approved_no_order'::text,
      jsonb_build_object('days', ano.days),
      (rule_ano->>'priority')::int
    from ano
    where coalesce((rule_ano->>'enabled')::boolean, false)
      and ano.days >= (rule_ano->>'threshold_days')::int
  ),
  -- 000307: last_sent_at added so the exhausted CTE can hold the escalation for
  -- one reminder-interval after the newest counted reminder.
  cap_counts as (
    select n.proof_id, n.rule_code, count(*)::int as sent_count,
      max(n.created_at) as last_sent_at
    from proof_nudges n
    join current_versions cv
      on cv.proof_id = n.proof_id and cv.version_id = n.proof_version_id
    where n.state in ('sending', 'sent')
    group by n.proof_id, n.rule_code
  ),
  exhausted as (
    select distinct on (f.proof_id)
      f.proof_id,
      'nudges_exhausted'::text as rule_code,
      jsonb_build_object(
        'rule', f.rule_code,
        'sent', cc.sent_count,
        'no_contact', (
          not exists (
            select 1 from proof_version_views v
            join proof_versions pv on pv.id = v.proof_version_id
            where pv.proof_id = f.proof_id and v.is_bot = false
          )
          and exists (
            select 1 from proofs p
            where p.id = f.proof_id and p.helpscout_last_customer_reply_at is null
          )
        )
      ) as rule_meta,
      (rule_nex->>'priority')::int as priority
    from flagged f
    join cap_counts cc
      on cc.proof_id = f.proof_id and cc.rule_code = f.rule_code
    where coalesce((rule_nex->>'enabled')::boolean, false)
      and f.rule_code in ('sent_never_viewed', 'viewed_not_actioned',
                          'approaching_dormant', 'stuck_in_progress')
      and cc.sent_count >= coalesce((automation->f.rule_code->>'max_nudges')::int, 2)
      -- 000307: give the customer one more reminder-interval to react to the
      -- FINAL reminder before escalating. Measured from the reminder ledger
      -- (reliable, unlike the Help Scout reply stamp the grace window used to
      -- depend on), in working days, matching the sender's repeat_days cooldown.
      -- Until this holds the proof stays in In-follow-up (proofs_in_follow_up
      -- Branch C); once it holds Branch C releases it and this row appears.
      and business_days_between(cc.last_sent_at::date, now()::date)
          >= coalesce((automation->f.rule_code->>'repeat_days')::int, 3)
    order by f.proof_id, cc.sent_count desc, f.rule_code
  ),
  follow_up as (
    select i.proof_id, i.rule_code
    from proofs_in_follow_up() i
  ),
  all_flagged as (
    select * from flagged
    union all
    select * from exhausted
  ),
  filtered as (
    select f.proof_id, f.rule_code, f.rule_meta, f.priority
    from all_flagged f
    where not exists (
      select 1 from proof_attention_snoozes s
      where s.proof_id = f.proof_id
        and s.rule_code = f.rule_code
        and s.snoozed_until > now()
    )
    and not (
      f.rule_code in ('sent_never_viewed', 'viewed_not_actioned', 'approaching_dormant',
                      'stuck_in_progress', 'nudges_exhausted')
      and exists (
        select 1 from proofs p
        where p.id = f.proof_id
          and greatest(p.helpscout_last_reply_at, p.helpscout_last_customer_reply_at)
              >= now() - make_interval(days => grace_days)
      )
    )
    and not (
      f.rule_code in ('sent_never_viewed', 'viewed_not_actioned')
      and exists (
        select 1 from follow_up fu
        where fu.proof_id = f.proof_id and fu.rule_code = f.rule_code
      )
    )
    and not (
      f.rule_code in ('sent_never_viewed', 'viewed_not_actioned')
      and exists (
        select 1 from exhausted ex
        where ex.proof_id = f.proof_id
          and ex.rule_meta->>'rule' = f.rule_code
      )
    )
  ),
  ranked as (
    select f.proof_id, f.rule_code, f.rule_meta, f.priority,
      row_number() over (
        partition by f.proof_id
        order by f.priority asc, f.rule_code
      ) as rn,
      array_agg(f.rule_code) over (
        partition by f.proof_id
        order by f.priority asc, f.rule_code
        rows between unbounded preceding and unbounded following
      ) as all_codes
    from filtered f
  )
  select r.proof_id,
    r.rule_code,
    case when array_length(array_remove(r.all_codes, r.rule_code), 1) > 0
      then r.rule_meta
        || jsonb_build_object('others', to_jsonb(array_remove(r.all_codes, r.rule_code)))
      else r.rule_meta
    end as rule_meta
  from ranked r
  where r.rn = 1;
end;
$function$;

revoke execute on function proofs.proofs_needing_attention() from anon, public;
grant execute on function proofs.proofs_needing_attention() to authenticated;

commit;
