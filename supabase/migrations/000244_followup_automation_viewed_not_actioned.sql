-- 000244 — follow-up automation: graduate `viewed_not_actioned` to auto-send.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push.
--
-- The follow-up spec shipped auto-send as `sent_never_viewed`-only, noting
-- that graduating another chase rule to auto "requires generalising
-- compute_nudge_candidates per-rule" (docs/followup-automation-spec.md,
-- "Deferred to Phase 2"). This does exactly that for `viewed_not_actioned`
-- (the customer opened the proof but hasn't approved or requested changes) —
-- the rule Rob chose to automate next.
--
-- compute_nudge_candidates() now returns BOTH chase populations, each row
-- tagged with two new columns the sender reads:
--   rule_code  — 'sent_never_viewed' | 'viewed_not_actioned'
--   anchor_at  — the timestamp the sender's threshold counts from:
--                  sent_never_viewed   → the send evidence (000224 formula)
--                  viewed_not_actioned → the customer's last non-bot view
-- The sent_never_viewed anchor is exactly its old send_evidence_at value, so
-- that population's behaviour is byte-for-byte unchanged.
--
-- The sender judges each candidate against its own rule's automation dials; a
-- rule whose mode isn't 'auto' has every candidate dropped (the dashboard
-- review queue handles those), so emitting the viewed_not_actioned rows is
-- inert until that rule's mode is 'auto' — which the config update at the foot
-- of this migration sets.
--
-- The viewed_not_actioned predicate mirrors proofs_needing_attention()'s vna
-- branch exactly (current version viewed, no approve / request_changes /
-- designer_override_approve since that last view) so the dashboard flag and
-- the auto-send candidate set stay in lockstep. Snoozes pause at proof level
-- (any rule), matching the spec and the existing definition.
--
-- Return-shape change → DROP + CREATE; grants re-stated service_role-only
-- (the 000223 pattern).

drop function if exists proofs.compute_nudge_candidates();

create function proofs.compute_nudge_candidates()
returns table (
  proof_id uuid,
  version_id uuid,
  version_number int,
  version_created_at timestamptz,
  rule_code text,
  anchor_at timestamptz,
  helpscout_conversation_id text,
  helpscout_conversation_url text,
  contact_full_name text,
  contact_email text,
  company_name text,
  designer_id uuid,
  designer_helpscout_user_id int,
  send_evidence_at timestamptz,
  last_customer_reply_at timestamptz,
  last_staff_reply_at timestamptz,
  snoozed boolean,
  auto_nudge_disabled boolean,
  has_followup_tag boolean
)
language sql
stable
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  -- Rule 1: sent_never_viewed — in_progress, HS-linked, current version with
  -- no non-bot view. Anchor = send evidence (000224: the version's own send
  -- stamp, falling back to the proof's last staff reply only when that reply
  -- postdates the version). Identical to the prior definition bar the two new
  -- columns.
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
    p.helpscout_tags @> array['follow up']::text[]
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
  -- since that last view. Anchor = the last view (itself proof of receipt, so
  -- never null — the no-send-evidence skip cannot fire for this population).
  -- send_evidence_at keeps the same formula as Rule 1 (the genuine outbound
  -- touch, used only by the sender's customer-replied floor; may be null here).
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
    p.helpscout_tags @> array['follow up']::text[]
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
$$;

revoke execute on function proofs.compute_nudge_candidates() from anon, public, authenticated;
grant execute on function proofs.compute_nudge_candidates() to service_role;

-- Graduate viewed_not_actioned to auto-send with explicit dials. The values
-- match the spec's "Standard persistence" default — 2 reminders per version,
-- 3 working days apart — and were previously implicit (the sender's fallbacks).
-- jsonb_set preserves every other key in needs_attention_rules: the rule
-- objects, the other automation entries, and helpscout_reply_grace_days.
update proofs.site_settings
set needs_attention_rules = jsonb_set(
  needs_attention_rules,
  '{automation,viewed_not_actioned}',
  '{"mode": "auto", "max_nudges": 2, "repeat_days": 3}'::jsonb,
  true
)
where id = 1;
