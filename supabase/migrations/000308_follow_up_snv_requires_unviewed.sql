-- 000308_follow_up_snv_requires_unviewed.sql
--
-- Stop a proof showing in BOTH "In follow-up" (as a stale sent_never_viewed
-- chase) and "Needs attention" (as viewed_not_actioned) once the customer has
-- opened it.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push.
--
-- Background
-- ----------
-- proofs_in_follow_up()'s Branch A / Branch C classify a proof as "being
-- chased under rule R" from the reminder LEDGER (proof_nudges.rule_code, frozen
-- at send time). The sender itself already switches populations correctly: the
-- sent_never_viewed arm of compute_nudge_candidates() excludes any proof whose
-- current version has a non-bot view, so once the customer opens the proof the
-- automation stops sending "you haven't opened it yet" reminders and (once past
-- threshold) starts the viewed_not_actioned chase instead.
--
-- But the ledger keeps the old sent_never_viewed rows, so the dashboard's
-- follow-up branches kept reporting a stale snv chase after the view. Symptom
-- (found on live, proof 929092c6): the proof showed under In-follow-up as
-- "sent_never_viewed, Reminder 3 of 4" AND under Needs attention as
-- "viewed_not_actioned" — a double-listing, because the S3 suppressor in
-- proofs_needing_attention() matches follow-up on (proof_id, rule_code) and the
-- two rule codes no longer agreed.
--
-- Fix: gate the sent_never_viewed classification in Branch A and Branch C on
-- "current version has no non-bot view", exactly mirroring the snv predicate in
-- proofs_needing_attention() and the snv arm of compute_nudge_candidates(). A
-- viewed proof therefore drops out of snv follow-up and lands in exactly one
-- place:
--   * still a live viewed_not_actioned auto-candidate (Branch B) -> In-follow-up
--     as viewed_not_actioned, and S3 now suppresses the Needs-attention chip
--     because the rule codes agree; or
--   * not a live vna candidate (grace / snooze / lifetime cap / reply) -> the
--     viewed_not_actioned row stands alone in Needs attention.
-- Either way: single-listed, and the dashboard matches what the sender is
-- actually doing.
--
-- viewed_not_actioned follow-up needs no such guard: its branches are anchored
-- on the customer's view (Branch B) or on vna ledger rows that only exist after
-- a view (Branch A), so they are inherently post-view.
--
-- One CREATE OR REPLACE, signature unchanged (grants + the
-- public_dashboard_projects / dashboard_list dependents survive). Body is the
-- live 000307 definition plus the marked `viewed_current` CTE and the two
-- guards.

begin;

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
  -- 000308: proofs whose current version has a genuine (non-bot) view. A viewed
  -- proof is no longer a sent_never_viewed member (the sender drops it from that
  -- population), so it must not keep surfacing as a stale snv chase.
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
  -- Branch A: already chasing — at least one reminder sent on the current
  -- version, cap not yet spent, rule in auto mode. (000246.)
  branch_a as (
    select u.proof_id, u.rule_code, u.sent_count,
      coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2) as max_nudges,
      u.last_sent_at
    from nudge_usage u
    where u.sent_count >= 1
      and u.sent_count < coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2)
      and coalesce((select (a->u.rule_code->>'mode') from automation), 'review') = 'auto'
      -- 000308: a sent_never_viewed chase is only live while the current version
      -- is unviewed; once viewed it belongs to viewed_not_actioned.
      and not (u.rule_code = 'sent_never_viewed'
               and u.proof_id in (select proof_id from viewed_current))
  ),
  -- Branch B: pending its first send — a live auto-nudge candidate the sender
  -- will act on but has not yet. Mirrors decideForProof()'s pre-send guards.
  -- (compute_nudge_candidates already excludes viewed proofs from the snv arm,
  -- so Branch B needs no 000308 guard.)
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
  -- repeat_days working days ago — still waiting out the final interval.
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
      -- 000308: same snv-unviewed guard as Branch A.
      and not (u.rule_code = 'sent_never_viewed'
               and u.proof_id in (select proof_id from viewed_current))
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

commit;
