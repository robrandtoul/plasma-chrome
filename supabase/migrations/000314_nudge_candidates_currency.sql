-- 000314_nudge_candidates_currency.sql
-- Expose the current version's currency to the nudge sender.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- Auto-chase review (2026-07-13): USD customers re-engage with reminders at
-- roughly half the GBP rate (16/74 vs 40/100 viewed within 7 days). Reminders
-- go out at 09:00/15:00 UTC — 5am on the US East Coast for the morning run.
-- send-nudges now defers USD-currency proofs to the afternoon run (~11:00
-- New York); this migration gives it the currency to decide with. Currency is
-- the house proxy for territory (EUR/USD are only used outside the UK).
--
-- Return-shape change → DROP + CREATE (same as 000223/000244), grants
-- re-stated. Body is otherwise byte-identical to the live definition
-- (verified via pg_get_functiondef on 2026-07-13): `cv.currency` is APPENDED
-- as the last output column, so the deployed sender keeps working whichever
-- of the migration / function deploy lands first (it reads columns by name;
-- a missing `currency` key reads as null → no deferral → old behaviour).
-- `currency` is null for per-direction-pricing variant rounds (000142/000144)
-- — the sender treats null as "not USD" and uses the normal window.

drop function if exists proofs.compute_nudge_candidates();

create function proofs.compute_nudge_candidates()
returns table(
  proof_id uuid,
  version_id uuid,
  version_number integer,
  version_created_at timestamptz,
  rule_code text,
  anchor_at timestamptz,
  helpscout_conversation_id text,
  helpscout_conversation_url text,
  contact_full_name text,
  contact_email text,
  company_name text,
  designer_id uuid,
  designer_helpscout_user_id integer,
  send_evidence_at timestamptz,
  last_customer_reply_at timestamptz,
  last_staff_reply_at timestamptz,
  snoozed boolean,
  auto_nudge_disabled boolean,
  has_followup_tag boolean,
  currency text
)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  -- Rule 1: sent_never_viewed — in_progress, HS-linked, current version with
  -- no non-bot view. Anchor = send evidence (000224 formula). Identical to the
  -- prior definition bar the appended currency column.
  select
    p.id,
    cv.id,
    cv.version_number,
    cv.created_at,
    'sent_never_viewed'::text,
    coalesce(
      cv.last_reply_sent_at,
      case when p.helpscout_last_reply_at >= cv.created_at
        then p.helpscout_last_reply_at
      end
    ),
    p.helpscout_conversation_id,
    p.helpscout_conversation_url,
    c.full_name,
    c.email,
    co.name,
    cv.created_by,
    pr.helpscout_user_id,
    coalesce(
      cv.last_reply_sent_at,
      case when p.helpscout_last_reply_at >= cv.created_at
        then p.helpscout_last_reply_at
      end
    ),
    p.helpscout_last_customer_reply_at,
    p.helpscout_last_reply_at,
    exists (
      select 1 from proofs.proof_attention_snoozes s
      where s.proof_id = p.id and s.snoozed_until > now()
    ),
    p.auto_nudge_disabled_at is not null,
    p.helpscout_tags @> array['follow up']::text[],
    cv.currency
  from proofs.proofs p
  join proofs.proof_versions cv on cv.proof_id = p.id and cv.is_current
  left join proofs.contacts c on c.id = p.contact_id
  left join proofs.companies co on co.id = c.company_id
  left join proofs.profiles pr on pr.id = cv.created_by
  where p.status = 'in_progress'
    and p.helpscout_conversation_id is not null
    and not exists (
      select 1 from proofs.proof_version_views v
      where v.proof_version_id = cv.id and v.is_bot = false
    )

  union all

  -- Rule 2: viewed_not_actioned — in_progress, HS-linked, current version
  -- viewed (non-bot) with no approve / request_changes / designer_override_approve
  -- since that last view. Anchor = the last view (never null for this
  -- population). Mirrors proofs_needing_attention()'s vna branch exactly.
  select
    p.id,
    cv.id,
    cv.version_number,
    cv.created_at,
    'viewed_not_actioned'::text,
    vv.last_viewed_at,
    p.helpscout_conversation_id,
    p.helpscout_conversation_url,
    c.full_name,
    c.email,
    co.name,
    cv.created_by,
    pr.helpscout_user_id,
    coalesce(
      cv.last_reply_sent_at,
      case when p.helpscout_last_reply_at >= cv.created_at
        then p.helpscout_last_reply_at
      end
    ),
    p.helpscout_last_customer_reply_at,
    p.helpscout_last_reply_at,
    exists (
      select 1 from proofs.proof_attention_snoozes s
      where s.proof_id = p.id and s.snoozed_until > now()
    ),
    p.auto_nudge_disabled_at is not null,
    p.helpscout_tags @> array['follow up']::text[],
    cv.currency
  from proofs.proofs p
  join proofs.proof_versions cv on cv.proof_id = p.id and cv.is_current
  join lateral (
    select max(v.viewed_at) as last_viewed_at
    from proofs.proof_version_views v
    where v.proof_version_id = cv.id and v.is_bot = false
  ) vv on vv.last_viewed_at is not null
  left join proofs.contacts c on c.id = p.contact_id
  left join proofs.companies co on co.id = c.company_id
  left join proofs.profiles pr on pr.id = cv.created_by
  where p.status = 'in_progress'
    and p.helpscout_conversation_id is not null
    and not exists (
      select 1 from proofs.proof_events pe
      where pe.proof_version_id = cv.id
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
        and pe.created_at >= vv.last_viewed_at
    )
$function$;

-- Grants: the proofs schema has no default privileges, and DROP wiped the old
-- set. Mirror live before the change: service_role (the sender), authenticated
-- (the Outbox review queue), nothing for anon.
revoke all on function proofs.compute_nudge_candidates() from public, anon;
grant execute on function proofs.compute_nudge_candidates() to authenticated, service_role;
