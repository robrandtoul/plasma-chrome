-- 000381_post_cap_return_surfaces_immediately.sql
--
-- A customer who comes back to their proof AFTER the reminder cap is spent
-- must reach Needs attention IMMEDIATELY — today that return actually DELAYS
-- the escalation.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push — the CLI link points at the
-- retired standalone project.
--
-- The delay mechanism
-- -------------------
-- The 000307 escalation (`nudges_exhausted`) only emits when the underlying
-- chase rule is still FIRING: the exhausted CTE joins `flagged`. But a return
-- view is exactly what un-flags the chase rules — it kills `sent_never_viewed`
-- outright and resets `viewed_not_actioned`'s clock to zero — so the proof
-- goes silent until the vna threshold (live: 5 working days) elapses again
-- with no further view. The strongest buying signal in the data, a customer
-- re-opening their proof after four reminders, therefore bought the proof up
-- to a WEEK of invisibility. Live evidence at author time (2026-08-03):
-- 848916fe's customer returned on 27 Jul; the proof only re-surfaced TODAY,
-- when the re-fired vna clock finally crossed 5 working days.
--
-- Why immediate surfacing is right: the customer re-initiated, and the spent
-- cap is precisely the state in which the automation is forbidden to reply —
-- only a human can act on the signal. Waiting for the chase rule to re-fire
-- measures OUR silence; this rule needs to measure THEIR return.
--
-- The fix — one predicate, used twice as a linked pair
-- ---------------------------------------------------
-- The trigger predicate: a non-bot proof_version_views row on the proof's
-- CURRENT version with viewed_at strictly after the newest counted reminder
-- (proof_nudges, state in ('sending','sent'), that rule, that version).
--
--  1. proofs_needing_attention(): the exhausted CTE gains an OR route — a
--     spent viewed_not_actioned cap AND the trigger predicate → emit the
--     nudges_exhausted row NOW, with no repeat_days wait and WITHOUT
--     requiring the underlying rule to be currently flagged (the return
--     view is exactly what un-flags it, so requiring `flagged` would
--     rebuild the very delay being removed). The join flips to
--     `cap_counts LEFT JOIN flagged`; the 000307 route keeps its flagged +
--     wait conditions verbatim as the first arm of the OR. The new route
--     re-states the eligibility the flagged join used to supply: rule
--     enablement, status = 'in_progress', and no decision event (approve /
--     request_changes / designer_override_approve) on the current version
--     after the last reminder — a customer who returned and then ACTED has
--     responded, which the customer-responded surfaces already handle, and
--     "reminders exhausted, still no response" would be a lie.
--
--     ⚠ The vna-only scope is deliberate, not an oversight. vna is the one
--     rule whose spent cap survives the trigger view. A sent_never_viewed
--     cap is retired by the customer's FIRST view: the proof crosses into
--     the vna population with a fresh cap and the automation keeps chasing,
--     so an immediate snv escalation would both lie ("exhausted" while
--     reminders continue) and double-list against the vna In-follow-up
--     entry for the life of that chase — S3/S4 suppress raw chase rows,
--     never nudges_exhausted. snv caps still escalate through the 000307
--     route exactly as before (they stay flagged precisely while unviewed).
--
--  2. proofs_in_follow_up(): Branch C gains AND NOT (trigger predicate), so
--     the held proof releases the moment the customer returns.
--
-- The two guards stay EXACT COMPLEMENTS, extending 000307's invariant: while
-- cap-spent with no post-cap view and the wait unelapsed → Branch C only;
-- wait elapsed → Branch C releases, the 000307 route emits (rule still
-- flagged, clocks long stale); post-cap view at any moment → Branch C
-- releases and, for a vna cap, the new route emits at once. (An snv cap's
-- first view already releases Branch C via the 000308 viewed-guard and
-- retires the snv chase entirely — the vna population takes over with a
-- fresh cap, so the immediate-surface pair is materially vna's.) S3/S4 keep
-- the raw chase rows suppressed in every arm, so "never opened" / "not
-- actioned" cannot leak into Needs attention around the handover. Once
-- emitted the row behaves exactly like a 000307 escalation: a staff reply
-- hides it for the grace window, a snooze parks it, and a customer decision
-- clears it — it does not clear on its own. If nudges_exhausted were
-- disabled a returned proof would simply wait for the raw vna threshold
-- exactly as today (the rule is enabled on live).
--
-- Downstream suppressors are deliberately untouched: snoozes and the 000208
-- Help Scout grace window still apply to the emitted row (`filtered` is
-- byte-identical). That matters for one live proof — see the preview.
--
-- Read-only preview against live, 2026-08-03 (new bodies run inline)
-- ------------------------------------------------------------------
-- (a) THREE proofs enter Needs attention under the new route, all
--     nudges_exhausted under viewed_not_actioned (cap 3–4 reminders spent):
--       · 300b1e3c Hereford Human Performance — last reminder 9 Jul,
--         returned 2 Aug (yesterday); visible NOWHERE today.
--       · 416a6087 Gridlock Traffic Control — final reminder 28 Jul 15:00,
--         viewed 15:51 the same afternoon; visible nowhere since.
--       · 7932ae60 Kylephilippe.com — final reminder 31 Jul 09:00, viewed
--         10:19; currently parked in Branch C, would have gone invisible
--         ~5 Aug. Moves from In-follow-up to Needs attention.
--     (The two prior-audit candidates were 300b1e3c and 416a6087 — both
--     still lost in limbo, both found; 848916fe and 2d516187 had since
--     surfaced naturally via the 000307 route after days invisible, and
--     their output is unchanged. a8afaac1 Spitfire viewed, emailed back and
--     got a staff reply within ten minutes today: it leaves In-follow-up
--     and its exhausted row is grace-held ≤3 days — correct, a human is
--     already on it — then surfaces via the new route if still undecided.)
--     Nothing drops out of live Needs attention. Counts: attention 7 → 10,
--     follow-up 53 → 51.
-- (b) Complement proof: ZERO proofs appear in both the new Branch C and the
--     new exhausted output.
-- (c) Restricted to proofs NOT matching the trigger predicate, EXCEPT both
--     ways against the live functions' output = 0 rows for BOTH functions —
--     everything else is byte-identical.
--
-- Tiles: proofs.dashboard_tile_counts() counts needs_attention /
-- in_follow_up off public_dashboard_projects.rule_code / follow_up_rule_code,
-- which the view populates from these two functions (verified against the
-- live view definition) — the tiles follow automatically; nothing else needs
-- changing.
--
-- Bodies are verbatim from the LIVE pg_get_functiondef (not the repo's
-- 000307/000308 files — live proofs_needing_attention() already carries
-- 000373's reorder_requested rule, absent from those files) apart from the
-- marked additions. Signatures unchanged, so grants and the
-- public_dashboard_projects / dashboard_list dependents survive; grants
-- re-stated anyway per the house pattern (live ACLs verified via pg_proc:
-- both authenticated; proofs_needing_attention also service_role).

begin;

-- ── 1. proofs_in_follow_up(): Branch C releases on a post-cap return view ────
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
  viewed_current as (
    select cv.proof_id
    from current_versions cv
    where exists (
      select 1 from proof_version_views v
      where v.proof_version_id = cv.version_id and v.is_bot = false
    )
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
  branch_a as (
    select u.proof_id, u.rule_code, u.sent_count,
      coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2) as max_nudges,
      u.last_sent_at
    from nudge_usage u
    where u.sent_count >= 1
      and u.sent_count < coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2)
      and coalesce((select (a->u.rule_code->>'mode') from automation), 'review') = 'auto'
      and not (u.rule_code = 'sent_never_viewed'
               and u.proof_id in (select proof_id from viewed_current))
  ),
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
      and not (u.rule_code = 'sent_never_viewed'
               and u.proof_id in (select proof_id from viewed_current))
      -- 000381 (linked pair — the same predicate, asserted rather than
      -- negated, is the new immediate arm of proofs_needing_attention()'s
      -- exhausted CTE): a non-bot view of the CURRENT version strictly after
      -- the newest counted reminder means the customer came back AFTER the
      -- cap was spent. The wait Branch C exists for is over — the automation
      -- is forbidden to send again, so holding the proof here would only
      -- hide the strongest buying signal there is. Release it; the exhausted
      -- row surfaces it to a human immediately. (Materially this releases
      -- vna rows only: a viewed snv-capped proof already left Branch C via
      -- the 000308 guard above, and the exhausted CTE's immediate arm is
      -- vna-scoped to match — snv hands over to vna's fresh cap instead.)
      and not exists (
        select 1
        from current_versions cv
        join proof_version_views v on v.proof_version_id = cv.version_id
        where cv.proof_id = u.proof_id
          and v.is_bot = false
          and v.viewed_at > u.last_sent_at
      )
  )
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

-- ── 2. proofs_needing_attention(): the exhausted CTE gains the immediate route ─
-- Byte-identical to the LIVE definition except the exhausted CTE: the join
-- flips to cap_counts LEFT JOIN flagged and the WHERE gains the OR (both
-- marked). Everything else — every rule CTE, snoozes, the grace window, the
-- S3/S4 suppressors, ranking — is verbatim from live.
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
  rule_rr   jsonb;
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
  rule_rr   := rules->'reorder_requested';
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
  -- 000373: the customer asked for more of these cards and no reorder project
  -- has been raised from it yet.
  --
  -- The clear condition is the existence of a CHILD proof pointing back here,
  -- not the designer doing anything to this row — because the whole design is
  -- that a reorder becomes its own project. A designer who decides not to
  -- raise one snoozes, exactly as with any other rule.
  --
  -- Calendar days, not working days: this measures how long a paying customer
  -- has been waiting, and they don't stop waiting at the weekend.
  --
  -- The abandoned guard is deliberate. helpscout_follow_up_tag is the one rule
  -- with no status filter at all, and 9 abandoned proofs currently carry that
  -- tag — masked only because the rule is off. Not repeating that here.
  rr as (
    select p.id as proof_id,
      p.reorder_request_quantity as quantity,
      (extract(epoch from now() - p.reorder_requested_at)::int) / 86400 as days
    from proofs p
    where p.reorder_requested_at is not null
      and p.status <> 'abandoned'
      and not exists (
        select 1 from proofs child
        where child.reorder_of_proof_id = p.id
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

    -- 000373. No threshold clause — see the header.
    union all
    select rr.proof_id, 'reorder_requested'::text,
      jsonb_build_object('days', rr.days, 'quantity', rr.quantity),
      (rule_rr->>'priority')::int
    from rr
    where coalesce((rule_rr->>'enabled')::boolean, false)
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
  -- 000381: the escalation now has two routes in, OR-ed below. The join flips
  -- to cap_counts LEFT JOIN flagged because the new route must fire when the
  -- underlying rule is NOT currently flagged — the customer's return view is
  -- exactly what un-flags it (a view kills sent_never_viewed outright and
  -- resets viewed_not_actioned's clock), so requiring a flagged row would
  -- rebuild the very delay this migration removes.
  exhausted as (
    select distinct on (cc.proof_id)
      cc.proof_id,
      'nudges_exhausted'::text as rule_code,
      jsonb_build_object(
        'rule', cc.rule_code,
        'sent', cc.sent_count,
        'no_contact', (
          not exists (
            select 1 from proof_version_views v
            join proof_versions pv on pv.id = v.proof_version_id
            where pv.proof_id = cc.proof_id and v.is_bot = false
          )
          and exists (
            select 1 from proofs p
            where p.id = cc.proof_id and p.helpscout_last_customer_reply_at is null
          )
        )
      ) as rule_meta,
      (rule_nex->>'priority')::int as priority
    from cap_counts cc
    left join flagged f
      on f.proof_id = cc.proof_id and f.rule_code = cc.rule_code
    where coalesce((rule_nex->>'enabled')::boolean, false)
      and cc.rule_code in ('sent_never_viewed', 'viewed_not_actioned',
                           'approaching_dormant', 'stuck_in_progress')
      and cc.sent_count >= coalesce((automation->cc.rule_code->>'max_nudges')::int, 2)
      and (
        -- 000307 route: the underlying rule is still firing and the customer
        -- has had one more reminder-interval to react to the FINAL reminder.
        -- Measured from the reminder ledger (reliable, unlike the Help Scout
        -- reply stamp the grace window used to depend on), in working days,
        -- matching the sender's repeat_days cooldown. Until this holds the
        -- proof stays in In-follow-up (proofs_in_follow_up Branch C); once it
        -- holds Branch C releases it and this row appears.
        (
          f.proof_id is not null
          and business_days_between(cc.last_sent_at::date, now()::date)
              >= coalesce((automation->cc.rule_code->>'repeat_days')::int, 3)
        )
        -- 000381 route (linked pair — the same predicate, negated, releases
        -- proofs_in_follow_up()'s Branch C): a non-bot view of the CURRENT
        -- version strictly after the newest counted reminder. The customer
        -- has re-initiated and the spent cap forbids the automation replying,
        -- so this surfaces to a human NOW — no wait, and no requirement that
        -- the underlying rule still be flagged.
        --
        -- viewed_not_actioned ONLY, and that scope is load-bearing: vna is
        -- the one rule whose spent cap survives the trigger view. A
        -- sent_never_viewed cap is RETIRED by that first view — the proof
        -- crosses into the vna population with a fresh cap and the
        -- automation chases on — so "reminders exhausted, still no response"
        -- would be false, and the row would sit beside the vna chase in
        -- In-follow-up for its whole life (the 000308 double-listing class;
        -- S3/S4 only suppress raw chase rows, never this one). The same
        -- handover covers a viewed proof capped under the two manual-nudge
        -- rules. Enablement is asserted here because this route no longer
        -- rides the flagged join that used to carry it.
        --
        -- A decision event after the last reminder means they went further
        -- than viewing and RESPONDED; the customer-responded surfaces own
        -- that case.
        or (
          cc.rule_code = 'viewed_not_actioned'
          and coalesce((rule_vna->>'enabled')::boolean, false)
          and exists (
            select 1
            from current_versions cv
            join proof_version_views v on v.proof_version_id = cv.version_id
            where cv.proof_id = cc.proof_id
              and v.is_bot = false
              and v.viewed_at > cc.last_sent_at
          )
          and exists (
            select 1 from proofs p
            where p.id = cc.proof_id and p.status = 'in_progress'
          )
          and not exists (
            select 1
            from current_versions cv
            join proof_events pe on pe.proof_version_id = cv.version_id
            where cv.proof_id = cc.proof_id
              and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
              and pe.created_at > cc.last_sent_at
          )
        )
      )
    order by cc.proof_id, cc.sent_count desc, cc.rule_code
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
grant execute on function proofs.proofs_needing_attention() to authenticated, service_role;

commit;
