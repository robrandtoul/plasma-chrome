-- 000373 — a customer reorder request reaches the dashboard.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push` (the CLI link points at the retired standalone
-- project; pushing there would replay ~250 migrations into the stock app).
--
-- 000372 gave the customer a way to ask for more cards, and gave a reorder
-- project a pointer back to the one it came from. Neither fact was visible to
-- a designer: a request stamped `reorder_requested_at` on a proof nobody was
-- looking at (an approved, delivered project sits well outside the working
-- set anyone opens), and a reorder raised from one was indistinguishable on
-- the dashboard from a proof a customer had just signed off. Rob's ask:
--
--   "Would be handy if it was clear on the dashboard that we're dealing with
--    a pre-approved reorder so we can handle accordingly."
--
-- Two halves, deliberately separate because they are about two different
-- proofs at two different moments:
--
--   1. The SOURCE proof, between the customer asking and a designer acting —
--      a needs-attention rule, so it lands in the queue that is already
--      worked rather than a new place to remember to look.
--   2. The NEW proof, once raised — two passthrough columns on the dashboard
--      view so the row can say what it is and link back.
--
-- ── Why a rule and not a stat tile ───────────────────────────────────────────
-- A tile costs seven coordinated edits, and the expensive one is a
-- client-side click-through predicate that has to mirror the SQL exactly —
-- the entire history of 000245 / 000246 / 000279 is those two drifting apart.
-- A rule costs one JSONB key and one union branch, and inherits snooze, the
-- resolve popover, the Outbox and the existing tile for free.
--
-- ── Why no threshold ────────────────────────────────────────────────────────
-- Every other threshold rule is measuring OUR silence. This one is measuring
-- a customer actively asking to give us money, so there is no honest number
-- of days to wait before mentioning it. `days` is still carried in rule_meta
-- for the chip ("asked 2 days ago"), it just doesn't gate.
--
-- ── Priority 1, alongside request_changes_no_version ────────────────────────
-- Duplicate priorities are normal here (approved_earlier_version and
-- nudges_exhausted have shared one since 000221) — the engine breaks ties
-- alphabetically on rule_code, and 'reorder_requested' < 'request_changes…',
-- so a reorder wins that tie. That is the precedence we want and it needs no
-- renumbering of the live table, whose priorities have drifted from
-- DEFAULT_RULES via admin drag-reorder. In practice the collision is
-- theoretical: a source proof is approved-and-paid, which excludes it from
-- every chase rule (all in_progress) and from approved_no_order.

begin;

-- ── 1. Seed the rule ─────────────────────────────────────────────────────────
-- Idempotent per the 000250 pattern: the `not (… ? '<code>')` guard means a
-- replay can never overwrite an admin's tuning of an existing rule.
update proofs.site_settings
set needs_attention_rules = needs_attention_rules || jsonb_build_object(
  'reorder_requested',
  jsonb_build_object('enabled', true, 'priority', 1)
)
where id = 1
  and not (needs_attention_rules ? 'reorder_requested');

-- ── 2. The rules engine ──────────────────────────────────────────────────────
-- Body taken VERBATIM from live pg_get_functiondef (2026-07-31, 12,254 chars,
-- the 000307 definition) — never from the migration files, which pin
-- search_path = public and no longer reproduce prod on a fresh replay. Four
-- additive edits and nothing else:
--   (a) the rule_rr declare + its rules->'reorder_requested' assignment
--   (b) the rr CTE, after ano
--   (c) one union branch at the end of flagged
--   (d) grants restated below
--
-- Deliberately NOT touched: the three literal rule-code lists in `filtered`.
-- A designer-side rule is correctly excluded from the Help Scout grace
-- window and the in-flight-automation suppression (both are about customer
-- chases), and it inherits the snooze guard automatically because that one
-- applies to every rule.
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
  -- that a reorder becomes its own project (docs/customer-reorder-spec.md §5).
  -- A designer who decides not to raise one snoozes, exactly as with any other
  -- rule.
  --
  -- Calendar days, not working days: this measures how long a paying customer
  -- has been waiting, and they don't stop waiting at the weekend.
  --
  -- The abandoned guard is deliberate. `helpscout_follow_up_tag` is the one
  -- rule with no status filter at all, and 9 abandoned proofs currently carry
  -- that tag — masked only because the rule is off. Not repeating that here.
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

-- Grants restated to match live exactly (authenticated + service_role, no
-- anon). CREATE OR REPLACE preserves them, but the 000148 → 000151 and
-- 000168 → 000174 sagas are both "the grant was silently lost".
grant execute on function proofs.proofs_needing_attention() to authenticated;
grant execute on function proofs.proofs_needing_attention() to service_role;

-- ── 3. The dashboard view ────────────────────────────────────────────────────
-- CREATE OR REPLACE with the two columns APPENDED — never a drop. A drop
-- would wipe the grants and break dashboard_list(), which is
-- `returns setof public_dashboard_projects` and does `select d.*`; because of
-- that `d.*` the new columns reach DashboardPage with no RPC change at all.
--
-- Body verbatim from live pg_get_viewdef (2026-07-31, the 000307 definition).
--
-- Both columns are plain passthroughs rather than a derived boolean: the id
-- carries strictly more than "is this a reorder" — it lets the row LINK to
-- the project it came from, which is the first thing a designer wants when
-- they see the chip.
create or replace view proofs.public_dashboard_projects as
 WITH current_versions AS (
         SELECT DISTINCT ON (pv.proof_id) pv.proof_id,
            pv.id AS version_id,
            pv.version_number,
            pv.material_display,
            pv.created_at AS version_created_at,
            pv.created_by AS designer_user_id
           FROM proofs.proof_versions pv
          WHERE pv.is_current
          ORDER BY pv.proof_id, pv.version_number DESC
        ), latest_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_event_at,
            e.event_type AS latest_event_type,
            e.actor_name AS latest_event_actor
           FROM proofs.dashboard_latest_events e
          ORDER BY e.proof_id, e.created_at DESC
        ), latest_non_view_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_non_view_event_at,
            e.event_type AS latest_non_view_event_type
           FROM proofs.dashboard_latest_events e
          WHERE e.event_type <> 'view'::text
          ORDER BY e.proof_id, e.created_at DESC
        ), current_view_state AS (
         SELECT DISTINCT ON (cv_1.proof_id) cv_1.proof_id,
            v.viewed_at AS current_version_viewed_at
           FROM proofs.proof_versions cv_1
             JOIN proofs.proof_version_views v ON v.proof_version_id = cv_1.id
          WHERE cv_1.is_current AND v.is_bot = false
          ORDER BY cv_1.proof_id, v.viewed_at DESC
        ), na AS (
         SELECT proofs_needing_attention.proof_id,
            proofs_needing_attention.rule_code,
            proofs_needing_attention.rule_meta
           FROM proofs.proofs_needing_attention() proofs_needing_attention(proof_id, rule_code, rule_meta)
        ), fu AS (
         SELECT proofs_in_follow_up.proof_id,
            proofs_in_follow_up.rule_code,
            proofs_in_follow_up.sent_count,
            proofs_in_follow_up.max_nudges,
            proofs_in_follow_up.last_sent_at
           FROM proofs.proofs_in_follow_up() proofs_in_follow_up(proof_id, rule_code, sent_count, max_nudges, last_sent_at)
        )
 SELECT p.id AS proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id AS contact_id,
    c.full_name AS contact_name,
    c.email AS contact_email,
    co.id AS company_id,
    co.name AS company_name,
    cv.version_id AS current_version_id,
    cv.version_number AS current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name AS designer_name,
    pr.designer_initials,
    pr.designer_colour,
    pr.avatar_url AS designer_avatar_url,
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
    p.helpscout_last_reply_at,
    p.helpscout_last_customer_reply_at,
    fu.rule_code AS follow_up_rule_code,
    fu.sent_count AS follow_up_sent_count,
    fu.max_nudges AS follow_up_max_nudges,
    fu.last_sent_at AS follow_up_last_sent_at,
    (EXISTS ( SELECT 1
           FROM proofs.proof_name_approvals a
          WHERE a.proof_version_id = cv.version_id AND a.state = 'changes_requested'::text)) AS has_open_change_request,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND (o.status = ANY (ARRAY['paid'::text, 'fulfilled'::text])))) THEN 'ordered'::text
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND o.status = 'sent'::text)) THEN 'awaiting_payment'::text
            ELSE NULL::text
        END AS order_status,
    -- 000373. Non-null only on a project raised FROM a customer reorder
    -- request — never on a designer Duplicate, which is what makes the
    -- dashboard chip mean "the customer asked for this".
    p.reorder_of_proof_id,
    -- The stamp on the SOURCE project. Stays set after the reorder is raised,
    -- so the row can still say a customer asked once the rule has cleared.
    p.reorder_requested_at
   FROM proofs.proofs p
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id
     LEFT JOIN current_versions cv ON cv.proof_id = p.id
     LEFT JOIN proofs.profiles pr ON pr.id = cv.designer_user_id
     LEFT JOIN latest_events le ON le.proof_id = p.id
     LEFT JOIN latest_non_view_events lne ON lne.proof_id = p.id
     LEFT JOIN current_view_state cvs ON cvs.proof_id = p.id
     LEFT JOIN na ON na.proof_id = p.id
     LEFT JOIN fu ON fu.proof_id = p.id
     LEFT JOIN LATERAL ( SELECT s.rule_code AS snooze_rule_code,
            s.snoozed_until,
            s.note AS snooze_note,
            pr2.full_name AS snoozed_by_name,
            pr2.designer_initials AS snoozed_by_initials,
            pr2.designer_colour AS snoozed_by_colour
           FROM proofs.proof_attention_snoozes s
             LEFT JOIN proofs.profiles pr2 ON pr2.id = s.snoozed_by
          WHERE s.proof_id = p.id AND s.snoozed_until > (now() - '24:00:00'::interval)
          ORDER BY s.snoozed_until DESC
         LIMIT 1) snz ON true;

-- Defensive re-pin (preserved by CREATE OR REPLACE, but 000186 once dropped
-- it and 000197 had to re-add it — cheap to guarantee here).
alter view proofs.public_dashboard_projects set (security_invoker = on);

revoke select on proofs.public_dashboard_projects from anon, public;
grant  select on proofs.public_dashboard_projects to authenticated;

commit;
