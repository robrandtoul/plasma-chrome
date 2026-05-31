-- 000209_admin_editable_dormancy_threshold.sql
--
-- Make the dormancy cutoff admin-editable, and fix the approaching_dormant
-- needs-attention rule, which still measured against a hard-coded 30-day
-- cutoff even though migration 000080 raised the REAL dormancy threshold
-- to 90 days. The two numbers had silently drifted 60 days apart: the
-- "Approaching dormant" chip lit up at ~25-30 idle days while proofs did
-- not actually flip to dormant until 90.
--
-- One source of truth now: site_settings.dormancy_threshold_days. Both the
-- nightly cron (forward flip to dormant) and the approaching_dormant rule
-- (the warning band before that flip) read it.
--
-- Default is 90, so this migration is a no-op on behaviour at apply time —
-- it only makes the number editable and re-aligns the warning band.
--
-- Pieces:
--   1. site_settings.dormancy_threshold_days int not null default 90.
--   2. auto_dormant_stale_proofs() — read the threshold from settings
--      (fallback 90) instead of the hard-coded '90 days' interval. Audit
--      metadata now reports the live threshold rather than a literal 90.
--   3. proofs_needing_attention() — body verbatim from 000208, with the
--      approaching_dormant CTE's two hard-coded 30s replaced by the
--      configurable cutoff so the warning band tracks the real threshold.

begin;

-- ── 1. settings column ────────────────────────────────────────────────────────

alter table site_settings
  add column if not exists dormancy_threshold_days int not null default 90
    check (dormancy_threshold_days > 0);

comment on column site_settings.dormancy_threshold_days is
  'Number of idle days after which auto_dormant_stale_proofs() flips an '
  'in_progress proof to dormant. Also the cutoff the approaching_dormant '
  'needs-attention rule counts back from. Admin-editable on the '
  'Needs-attention settings page. Default 90 (was hard-coded in 000080).';

-- ── 2. cron forward-flip reads the setting ────────────────────────────────────
-- Body identical to 000080 except the threshold is now read from
-- site_settings rather than the literal '90 days', and the audit row's
-- threshold_days reports the live value. CREATE OR REPLACE preserves the
-- 000182 REVOKE EXECUTE and the search_path pin — no privilege restate.

create or replace function auto_dormant_stale_proofs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  threshold_days int;
  threshold      interval;
begin
  -- Single source of truth; defensive fallback if the row/column is
  -- somehow null (column is NOT NULL DEFAULT 90, so this is belt-only).
  select coalesce(dormancy_threshold_days, 90)
    into threshold_days
    from site_settings
    where id = 1;
  threshold_days := coalesce(threshold_days, 90);
  threshold := make_interval(days => threshold_days);

  -- Flip stale in_progress proofs to dormant, capture which rows moved
  -- so we can write matching audit entries in the same transaction. NULL
  -- last_activity_at is defensively treated as stale.
  with flipped as (
    update proofs
    set status = 'dormant'
    where status = 'in_progress'
      and (last_activity_at is null
           or last_activity_at < now() - threshold)
    returning id, last_activity_at, contact_id
  )
  insert into audit_log (
    actor_id, actor_email, actor_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  )
  select
    null,                -- no authenticated caller in cron context
    null,
    'system',            -- audit viewer-friendly actor label
    'proof.auto_dormant',
    'proof',
    f.id::text,
    (select full_name from contacts where id = f.contact_id),
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object('status', 'dormant'),
    jsonb_build_object(
      'actor_context', 'system_cron',
      'threshold_days', threshold_days,
      'last_activity_at', f.last_activity_at
    )
  from flipped f;
end;
$$;

-- ── 3. rules engine: approaching_dormant tracks the real cutoff ────────────────
-- Body verbatim from 000208 (the latest definition) with two changes only:
--   * dormancy_cutoff is read from site_settings alongside the rules JSONB.
--   * the `ad` CTE replaces the two hard-coded 30s with dormancy_cutoff, so
--     the warning band is (cutoff - threshold_days, cutoff) days-ago.
-- Everything else — the snooze exclusion, the 000208 Help Scout grace
-- suppression, the other five rules — is unchanged.

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
  'needs_attention_rules.helpscout_reply_grace_days. 000209: approaching_dormant '
  'counts back from site_settings.dormancy_threshold_days (was hard-coded 30). '
  'Body otherwise verbatim from 000208.';

commit;
