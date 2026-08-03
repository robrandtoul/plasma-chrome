-- 000380_returner_reminder_tone.sql
-- A "stuck, not hot" reminder tone for customers who keep coming back.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- A customer who returns to their proof on two or more separate days without
-- deciding approves at 34%, against 50% for the rest of the
-- viewed_not_actioned population. Repeat visits without a decision aren't a
-- hot lead warming up — they're someone stuck, usually on price (the #1
-- stated loss reason, and this population has seen the price grid). Chasing
-- them with "are you happy for us to go ahead?" pushes on the wrong door.
-- Same schedule, better words: timing, caps, cooldowns and the candidate
-- population are ALL unchanged — no WHERE clause in this function changes —
-- the sender just prefers an obstacle-removal template (seeded in part 2)
-- when the new fact is true, and that template's proof link auto-opens the
-- "Not ready to approve?" panel so saying what's in the way is one click,
-- not a composed email.
--
-- Part 1: compute_nudge_candidates() gains ONE appended output column,
-- return_views boolean — true iff the proof's CURRENT version has non-bot
-- views on 2+ distinct Europe/London calendar days. London days for the same
-- reason 000363 counts them: a 17:30 BST visit must not land in tomorrow's
-- day. The sent_never_viewed arm emits a literal false (its own WHERE clause
-- means that population has no non-bot views at all); the
-- viewed_not_actioned arm counts distinct days inside the existing vv
-- lateral, so it costs no extra scan and the join condition is untouched
-- (max(viewed_at) is null exactly when the day count is 0, as before).
-- Return-shape change → DROP + CREATE (the 000223/000244/000314 pattern),
-- grants re-stated. Body re-emitted from the LIVE pg_get_functiondef, read
-- 2026-08-03 — live matched the repo's 000314 file byte for byte, so there
-- was no drift to fold in.
--
-- Part 2: seed the reminder-1 return-tone body,
-- nudge_viewed_not_actioned_return. send-nudges prefers the _return variant
-- at each chain position when return_views is true, falling back to that
-- position's standard id where no return variant exists — only this base
-- body is seeded, so reminders 2+ DELIBERATELY fall back to the standard
-- _2/_final copy (one softened first touch, then the normal close-out).
-- Same house pattern as 000207/000313: ON CONFLICT DO NOTHING so admin
-- edits are never clobbered; body mirrors DEFAULT_BODIES in
-- src/lib/replyTemplates.ts (and NUDGE_DEFAULT_BODIES in the edge twin);
-- no sign-off (Help Scout appends the signature); the nudge_ prefix files
-- it with the other reminders in the admin editor.
--
-- ⚠ Deploy order is free — function-first is safe: the deployed sender
-- defaults a missing return_views column to false (standard copy, exactly
-- today's behaviour), and a migrated database under the OLD sender just
-- carries a column nobody reads yet. Same order-safety contract as
-- 000244/000314.

begin;

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
  currency text,
  return_views boolean
)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  -- Rule 1: sent_never_viewed — in_progress, HS-linked, current version with
  -- no non-bot view. Anchor = send evidence (000224 formula). Identical to
  -- the prior definition bar the appended return_views column, which is a
  -- literal false here: this arm's own WHERE clause means the current
  -- version has no non-bot views at all, so there is nothing to count.
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
    cv.currency,
    false
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
  -- return_views (000380) rides the existing vv lateral — one scan serves
  -- both the anchor and the distinct-London-day count, and the join
  -- condition on last_viewed_at is unchanged.
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
    cv.currency,
    vv.return_views
  from proofs.proofs p
  join proofs.proof_versions cv on cv.proof_id = p.id and cv.is_current
  join lateral (
    select
      max(v.viewed_at) as last_viewed_at,
      count(distinct (v.viewed_at at time zone 'Europe/London')::date) >= 2
        as return_views
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

-- Grants: the proofs schema has no default privileges, and DROP wiped the
-- old set. Mirror live before the change (pg_proc ACL read 2026-08-03):
-- service_role (the sender), authenticated (the Outbox review queue),
-- nothing for anon.
revoke all on function proofs.compute_nudge_candidates() from public, anon;
grant execute on function proofs.compute_nudge_candidates() to authenticated, service_role;

-- ── Part 2: the return-tone reminder body ────────────────────────────────────
-- The copy never references visits, views, or any form of tracking (the
-- house rule: tracking is only ever disclosed in the negative) — it simply
-- removes obstacles: the proof is saved, there is no rush, and if something
-- is in the way (price, a detail, a question) the customer can reply or use
-- the "Not ready to approve?" option, which the sender's link opens for them.

insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'nudge_viewed_not_actioned_return',
    'Reminder — customer came back',
    'First automated reminder for a customer who has returned to their proof on two or more separate days without deciding — stuck rather than hot. Obstacle-removal tone: no closing pressure, and no reference to visits or views. Its link opens the "Not ready to approve?" panel on the proof page. Later reminders fall back to the standard sequence.',
    E'Hi {first_name},\n\nNo rush on your card proof{? company} for {company}{/?} — it''s saved and waiting whenever you''re ready.\n\nIf anything''s giving you pause — the price, a detail you''d like changed, or a question — just reply, or use the "Not ready to approve?" option on your proof page and we''ll happily adjust:\n\n{url}'
  )
on conflict (id) do nothing;

commit;
