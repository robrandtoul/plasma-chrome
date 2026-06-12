-- 000224 — scope the nudge sender's send-evidence fallback to the version it
-- is meant to be evidence FOR.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push.
--
-- From the 2026-06-12 adversarial review (finding 2). The send-evidence
-- anchor is coalesce(version.last_reply_sent_at, proofs.helpscout_last_reply_at)
-- — the fallback exists for proofs whose versions were sent directly from
-- Help Scout rather than through the proof viewer's send panel. But an
-- UNSCOPED fallback can predate the version: upload v3 on Thursday evening
-- without sending it, and Friday's 9am run finds a current version with zero
-- views plus "send evidence" in the form of last week's unrelated staff
-- reply — and emails the customer "it doesn't look like it's been opened
-- yet" about a version they were never told existed.
--
-- Fix: the fallback reply only counts as send evidence when it POSTDATES the
-- current version's creation — a reply sent before v3 existed cannot be
-- proof that v3 went out. Versions genuinely announced from Help Scout keep
-- their evidence (the announcing reply necessarily postdates the upload);
-- the never-announced case now skips with skipped_no_send_evidence, which
-- the Outbox surfaces under "Needs you" as the designer-side problem it is.
--
-- Function body change only — same return shape as 000223, so CREATE OR
-- REPLACE preserves the existing grants (service_role only).

create or replace function proofs.compute_nudge_candidates()
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
    -- Send evidence (000224): the version's own send stamp, falling back to
    -- the proof's last staff reply ONLY when that reply postdates the
    -- version — a reply older than the version cannot be evidence it was
    -- sent. Null → the decision module fails toward silence.
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
$$;
