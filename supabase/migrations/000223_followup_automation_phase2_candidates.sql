-- 000223 — follow-up automation Phase 2: surface the Help Scout "follow up"
-- tag to the nudge sender's candidate query.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push.
--
-- The Phase 2b tag sync (helpscout-webhook now mirrors conversation tags
-- into proofs.helpscout_tags on the convo.tags event) makes the long-dead
-- "follow up" tag live data. The spec pre-decided the automation
-- interaction: the tag means a HUMAN has flagged the conversation for
-- follow-up, so the bot must NOT also chase — the sender skips the proof
-- with a logged outcome (skipped_followup_tag) rather than letting the
-- 000154 priority ordering decide silently. That decision lives in the
-- sender's tested decision module; this migration just hands it the fact.
--
-- compute_nudge_candidates() gains one output column:
--   has_followup_tag — proofs.helpscout_tags @> '{follow up}'
--
-- A return-shape change means DROP + CREATE (CREATE OR REPLACE cannot alter
-- an OUT column list), so the grants are re-stated below — service_role
-- only, same as 000214. No other behaviour change: body is verbatim from
-- 000214 apart from the marked addition.

drop function if exists proofs.compute_nudge_candidates();

create function proofs.compute_nudge_candidates()
returns table (
  proof_id uuid,
  version_id uuid,
  version_number int,
  version_created_at timestamptz,
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
  select
    p.id,
    cv.id,
    cv.version_number,
    cv.created_at,
    p.helpscout_conversation_id,
    p.helpscout_conversation_url,
    c.full_name,
    c.email,
    co.name,
    cv.created_by,
    pr.helpscout_user_id,
    coalesce(cv.last_reply_sent_at, p.helpscout_last_reply_at),
    p.helpscout_last_customer_reply_at,
    p.helpscout_last_reply_at,
    exists (
      select 1 from proofs.proof_attention_snoozes s
      where s.proof_id = p.id and s.snoozed_until > now()
    ),
    p.auto_nudge_disabled_at is not null,
    -- 000223: the human-flagged follow-up marker, synced from Help Scout by
    -- the webhook. The decision module skips tagged proofs (a human owns the
    -- chase) with outcome skipped_followup_tag.
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
$$;

revoke execute on function proofs.compute_nudge_candidates() from anon, public, authenticated;
grant execute on function proofs.compute_nudge_candidates() to service_role;
