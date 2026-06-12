-- 000221 — needs-attention: reminder exhaustion as a first-class rule, plus
-- multi-rule visibility in rule_meta.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push — the CLI link points at the
-- retired standalone project.
--
-- Two changes to proofs_needing_attention(), both from the follow-up
-- automation spec (docs/followup-automation-spec.md, section 5 and the
-- "Deferred to Phase 2" list):
--
-- 1. NEW RULE `nudges_exhausted` — "2 reminders sent, still no response"
--    must land somewhere a human already looks, not die silently as a
--    skipped_capped Outbox row. Fires when:
--      * a chase rule (sent_never_viewed / viewed_not_actioned /
--        approaching_dormant / stuck_in_progress) is STILL firing for the
--        proof, AND
--      * the reminder ledger (proof_nudges) shows the per-version cap is
--        spent for that rule on the CURRENT version — counting rows in
--        state 'sending' or 'sent' of ANY source, the same truth table as
--        nudge_cap_rows() / capRows() in the sender. Manual reminders count,
--        so the escalation works whether or not automation is switched on.
--    The cap per rule comes from the automation config
--    (needs_attention_rules->'automation'-><rule>->>'max_nudges', default 2).
--    rule_meta carries:
--      * rule       — the underlying chase rule that exhausted
--      * sent       — how many reminders went out
--      * no_contact — true when the customer has NEVER non-bot-viewed any
--        version of the proof AND never replied on Help Scout: a strong
--        deliverability signal (wrong address / spam folder) that the chip
--        copy surfaces as "may not be reaching them". A third email won't
--        fix that; the resolution copy says to call instead.
--    Seeded at priority 2 (just below request_changes_no_version): the whole
--    point is to outrank the chase rule it supersedes, so the chip reads
--    "needs a call", not "send another reminder". Suppressed by the 000208
--    Help Scout grace window like the chase rules — the sender's own send
--    self-stamps helpscout_last_reply_at, so the escalation appears once the
--    customer has had the grace window to answer the final reminder, which
--    is the right moment to pick up the phone. Snoozeable like every rule.
--
-- 2. MULTI-RULE VISIBILITY — the engine keeps its one-chip-per-proof
--    collapse (highest priority wins), but the winning row's rule_meta now
--    carries every OTHER rule that also fired and survived the snooze/grace
--    guards, as rule_meta.others (text array, priority order). The resolve
--    popover renders "Also: …" from it, so a changes-requested proof that is
--    ALSO stuck for 15 days no longer hides the second signal. Consumers
--    that ignore rule_meta are unaffected — the return shape is unchanged.
--
-- CREATE OR REPLACE with an unchanged signature, so the 000182 grants and
-- search_path pin survive. public_dashboard_projects sources rule_code from
-- this function and dashboard_tile_counts() counts off that view, so both
-- pick the new rule up automatically — no view DDL needed.
--
-- Body is verbatim from 000217 apart from the marked additions. The two
-- newest rules (approved_earlier_version, nudges_exhausted) read `enabled`
-- through coalesce(.., false) so a fresh replay where their config keys are
-- not yet seeded fails toward silence rather than erroring.

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
  -- The per-rule automation dials (000214) — max_nudges per chase rule is
  -- the exhaustion threshold. Missing block reads as empty (defaults apply).
  automation := coalesce(rules->'automation', '{}'::jsonb);
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
  -- last_activity_at is in the (cutoff - threshold, cutoff) days-ago band,
  -- where cutoff = site_settings.dormancy_threshold_days (000209). Gives a
  -- window to ping the customer before the auto-dormant cron flips it.
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (dormancy_cutoff - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - make_interval(days => dormancy_cutoff)
  ),
  -- Rule 6: stuck in progress - in_progress with no event or view in
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
  -- Rule 7 (000217): customer approved a non-current version while the
  -- current version is still unapproved by that recipient. No threshold.
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

    -- 000217: approved-earlier-version. No threshold; rule_meta carries the
    -- stranded version number for future chip copy.
    union all
    select aev.proof_id, 'approved_earlier_version'::text,
      jsonb_build_object('version', aev.approved_version),
      (rule_aev->>'priority')::int
    from aev
    where coalesce((rule_aev->>'enabled')::boolean, false)
  ),
  -- 000221: reminder-cap usage per (proof, chase rule) on the CURRENT
  -- version. Same truth table as nudge_cap_rows()/capRows(): a row counts
  -- iff state is 'sending' or 'sent', ANY source — manual reminders spend
  -- the cap too, dry-run rows never count.
  cap_counts as (
    select n.proof_id, n.rule_code, count(*)::int as sent_count
    from proof_nudges n
    join current_versions cv
      on cv.proof_id = n.proof_id and cv.version_id = n.proof_version_id
    where n.state in ('sending', 'sent')
    group by n.proof_id, n.rule_code
  ),
  -- 000221: the exhaustion rule — a chase rule still firing whose reminder
  -- cap is spent. One row per proof (the most-reminded rule wins the meta).
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
    order by f.proof_id, cc.sent_count desc, f.rule_code
  ),
  all_flagged as (
    select * from flagged
    union all
    select * from exhausted
  ),
  -- The snooze and grace guards, applied to every fired rule BEFORE the
  -- collapse, so rule_meta.others only ever names rules a designer could
  -- actually act on (a snoozed or grace-suppressed rule is not "also
  -- firing" from the dashboard's point of view).
  filtered as (
    select f.proof_id, f.rule_code, f.rule_meta, f.priority
    from all_flagged f
    -- Exclude proof+rule combinations with an active snooze.
    where not exists (
      select 1 from proof_attention_snoozes s
      where s.proof_id = f.proof_id
        and s.rule_code = f.rule_code
        and s.snoozed_until > now()
    )
    -- 000208: suppress the customer-chase rules when there has been a recent
    -- Help Scout reply (staff or customer) on the linked conversation.
    -- nudges_exhausted joins the list (000221): the final reminder
    -- self-stamps helpscout_last_reply_at, so the escalation surfaces once
    -- the grace window has passed without a customer response — the right
    -- moment for a call. Leaves request_changes_no_version (owe a version),
    -- helpscout_follow_up_tag and approved_earlier_version alone — none of
    -- those are resolved by a reply.
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
  ),
  -- 000221: one-chip collapse with the other surviving rules carried in
  -- rule_meta.others (priority order), so secondary signals stay visible.
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

-- Seed the exhaustion rule into the live needs_attention_rules document.
-- Priority 2 — above every chase rule it supersedes, sharing the ordinal
-- with approved_earlier_version / helpscout_follow_up_tag (the alphabetical
-- tiebreak ranks approved_earlier_version > helpscout_follow_up_tag >
-- nudges_exhausted; simultaneous firing is rare and any of the three is a
-- legitimate top chip). No threshold or calendar keys — the cap config in
-- the automation block IS the threshold. Idempotent: only writes when the
-- key is absent, so a later admin edit is preserved on re-run.
update proofs.site_settings
set needs_attention_rules = jsonb_set(
  needs_attention_rules,
  '{nudges_exhausted}',
  '{"enabled": true, "priority": 2}'::jsonb,
  true
)
where id = 1
  and not (needs_attention_rules ? 'nudges_exhausted');
