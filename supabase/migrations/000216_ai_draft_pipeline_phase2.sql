-- AI draft pipeline Phase 2 (docs/ai-draft-pipeline-spec.md): the ai_drafts
-- ledger and the mode switch. Schema-qualified for the merged stock project
-- (proofs schema); applied by Rob via the stock-control dashboard SQL editor
-- per the prod-gating rule — never pushed via CLI.
--
-- The proofs schema has NO default privileges: every grant is stated
-- explicitly. Writes are service-role only (the ai-draft edge function);
-- designers read the ledger for the future admin Drafts panel.

-- Master switch. 'off' (default): the ai-draft function no-ops.
-- 'shadow': pipeline runs, results land ONLY in this ledger — nothing is
-- created in Help Scout. 'live': drafts + notes + tag appear in Help Scout.
alter table proofs.settings
  add column if not exists ai_drafts_mode text not null default 'off'
    constraint settings_ai_drafts_mode_check check (ai_drafts_mode in ('off', 'shadow', 'live'));

create table proofs.ai_drafts (
  id uuid primary key default gen_random_uuid(),
  helpscout_conversation_id text not null,
  trigger_event text not null,
  -- The newest customer thread at draft time: the dedupe anchor. A webhook
  -- retry for the same customer message is a no-op; a new customer message
  -- re-triggers (stale-draft regeneration).
  trigger_thread_id text,
  dedupe_key text not null unique,
  state text not null default 'processing'
    check (state in ('processing', 'shadow', 'drafted', 'abstained', 'blocked', 'skipped', 'failed')),
  mode text not null check (mode in ('shadow', 'live')),
  category text,
  confidence text,
  summary text,
  draft_body text,
  note_body text,
  abstain_or_block_reason text,
  note_warnings text[],
  usage_input integer,
  usage_output integer,
  model text,
  -- Help Scout artefact ids (live mode only).
  hs_draft_thread_id text,
  hs_note_thread_id text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index ai_drafts_conversation_idx
  on proofs.ai_drafts (helpscout_conversation_id, created_at desc);
create index ai_drafts_created_idx
  on proofs.ai_drafts (created_at desc);

-- Explicit grant matrix (no defaults in this schema). Authenticated gets
-- SELECT only — deliberately NO insert/update/delete (the 000176 footgun
-- does not apply here since proofs has no default privileges, but stating
-- intent explicitly): all writes flow through the service-role function.
grant all on proofs.ai_drafts to service_role;
grant select on proofs.ai_drafts to authenticated;

alter table proofs.ai_drafts enable row level security;

create policy "designers read ai drafts"
  on proofs.ai_drafts for select
  to authenticated
  using (true);

-- No anon access of any kind: customer-facing surfaces never see the ledger.
revoke all on proofs.ai_drafts from anon;
