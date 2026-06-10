-- 000214: Follow-up automation Phase 1 — nudge ledger, heartbeat, config,
-- candidates function, analytics view.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or MCP apply_migration). Do NOT use
-- `pnpm db:push:confirm` / `supabase db push` — the CLI link points at the
-- retired standalone project and the merged project has no 000NNN migration
-- history to replay against. Every object below is schema-qualified for the
-- same reason; functions pin the live convention
-- `search_path = proofs, public, extensions, pg_temp`.
--
-- Spec: docs/followup-automation-spec.md. Phase 1 is dry-run only: the
-- send-nudges edge function computes candidates and writes ledger rows, but
-- settings.auto_nudges_enabled (added here, default false) keeps every run in
-- dry_run mode until Phase 2 deliberately flips it.
--
-- ⚠ Grants note (inverted 000176 footgun): the proofs schema on the merged
-- project has NO default privileges — a new table is born with no grants at
-- all, including to service_role. Every grant below is therefore explicit;
-- forgetting service_role would make the edge function's writes fail.

-- ── 1. proof_nudges — the single nudge ledger ────────────────────────────────
--
-- One row per nudge, manual and automatic alike, so cap and spacing maths
-- count human touches. Rows are written claim-first by the auto path: INSERT
-- state='sending' before the Help Scout POST (the unique index below is the
-- idempotency gate), then UPDATE to sent/failed. Manual rows are written by
-- send-helpscout-reply after a successful send. Dry-run rows carry
-- state='dry_run' with `outcome` describing what WOULD have happened
-- ('would_send', 'suppressed_sibling', 'skipped: …'); they are excluded from
-- the cap/cooldown read path structurally (see nudge_cap_rows) and retained
-- permanently as the analytics baseline cohort.
--
-- outcome is deliberately free text (no CHECK): values in use include
-- would_send, sent, superseded: <reason>, skipped_closed_conversation,
-- recipient_mismatch, suppressed_sibling, suppressed_daily_touch,
-- skipped_customer_replied, skipped_snoozed, skipped_opted_out,
-- skipped_capped, skipped_cooldown, skipped_grace_window,
-- skipped_out_of_window, skipped_automation_disabled, failed: <reason>.

create table proofs.proof_nudges (
  id uuid primary key default gen_random_uuid(),
  proof_id uuid not null references proofs.proofs(id) on delete cascade,
  -- Version current at send time. Nullable only for the FK's on delete
  -- set null; the writers always populate it.
  proof_version_id uuid references proofs.proof_versions(id) on delete set null,
  rule_code text not null,
  template_id text,
  source text not null check (source in ('auto', 'manual')),
  state text not null check (state in ('sending', 'sent', 'failed', 'skipped', 'dry_run')),
  outcome text,
  helpscout_conversation_id text,
  helpscout_thread_id bigint,
  -- Designer attribution for manual rows; null for auto rows.
  sent_by uuid references proofs.profiles(id) on delete set null,
  -- Snapshot of the exact body sent (or that would have been sent, for
  -- dry_run rows) — the Outbox shows this, and it is the audit record of
  -- what the customer actually received.
  rendered_body text,
  -- UTC send date, the daily-dedupe key for the unique indexes below.
  sent_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- Claim-first idempotency gate: one REAL auto send per proof/rule/version/day.
-- The sender INSERTs state='sending' before posting to Help Scout; losing the
-- conflict means another run already claimed this send today. Scoped to the
-- true idempotency domain (sending/sent) — dry_run and skipped rows stay out
-- so a morning dry/test run can never silently block the same day's first
-- live send (the flip-day lockout the adversarial review caught).
create unique index proof_nudges_auto_claim
  on proofs.proof_nudges (proof_id, rule_code, proof_version_id, sent_date)
  where source = 'auto' and state in ('sending', 'sent');

-- One automated send per Help Scout conversation per day, database-enforced
-- (spec: "one touch per customer per day" at the conversation level —
-- multiple proofs can legitimately share one conversation). Only real sends
-- occupy the slot; dry-run and skipped rows don't.
create unique index proof_nudges_convo_daily
  on proofs.proof_nudges (helpscout_conversation_id, sent_date)
  where source = 'auto' and state in ('sending', 'sent');

create index proof_nudges_proof_idx
  on proofs.proof_nudges (proof_id, created_at desc);

-- Append-only from the clients' perspective: designers read (Outbox, review
-- queue, analytics); every write goes through the service-role edge
-- functions so auto-vs-manual counting stays trustworthy.
alter table proofs.proof_nudges enable row level security;

create policy proof_nudges_select on proofs.proof_nudges
  for select to authenticated using (true);

revoke all on proofs.proof_nudges from anon, public;
grant select on proofs.proof_nudges to authenticated;
grant all on proofs.proof_nudges to service_role;

-- ── 2. nudge_runs — heartbeat ────────────────────────────────────────────────
--
-- One row per scheduler run, including zero-candidate runs: the row is the
-- pipeline's FIRST write (started_at before computing, finished_at stamped
-- last), so a crash mid-run is visible as an open row, and a silently-dead
-- cron is visible as a stale started_at. The Outbox panel surfaces both.
-- An open row (started_at, no finished_at) gates the next auto-send run
-- until a human clears it.

create table proofs.nudge_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null check (mode in ('dry_run', 'live')),
  candidates_computed int,
  sent int,
  skipped int,
  errors jsonb,
  note text
);

create index nudge_runs_started_idx on proofs.nudge_runs (started_at desc);

alter table proofs.nudge_runs enable row level security;

create policy nudge_runs_select on proofs.nudge_runs
  for select to authenticated using (true);

revoke all on proofs.nudge_runs from anon, public;
grant select on proofs.nudge_runs to authenticated;
grant all on proofs.nudge_runs to service_role;

-- ── 3. Per-proof durable opt-out ─────────────────────────────────────────────
--
-- One-click "don't auto-chase this proof" from the review queue / resolve
-- popover. Designers set/clear it directly (authenticated already has CRUD
-- on proofs); the sender hard-skips when non-null.

alter table proofs.proofs add column auto_nudge_disabled_at timestamptz;

-- ── 4. Automation kill switch ────────────────────────────────────────────────
--
-- The automation-scoped switch (spec: replies_enabled gates only the manual
-- designer send path, so automation needs its own control). false = the
-- nightly job still runs and logs, but every row is dry_run and nothing is
-- sent. Default false: Phase 1 IS the dry run.

alter table proofs.settings add column auto_nudges_enabled boolean not null default false;

-- ── 5. Per-rule automation config ────────────────────────────────────────────
--
-- Lives under a TOP-LEVEL sibling key inside needs_attention_rules, NOT
-- inside the rule objects: the admin page's Reset-to-defaults merge
-- (AdminNeedsAttentionPage.tsx) replaces rule objects wholesale but
-- preserves unknown top-level keys (same reason helpscout_reply_grace_days
-- survives, PV-2026W22-239). mode: 'auto' | 'review' | 'off'.
-- lifetime_max is the per-proof ceiling across all versions and rules.
-- Idempotent: skipped if an automation key already exists.

update proofs.site_settings
set needs_attention_rules = needs_attention_rules || jsonb_build_object(
  'automation', jsonb_build_object(
    'sent_never_viewed',   jsonb_build_object('mode', 'auto',   'repeat_days', 3, 'max_nudges', 2),
    'viewed_not_actioned', jsonb_build_object('mode', 'review'),
    'approaching_dormant', jsonb_build_object('mode', 'review'),
    'stuck_in_progress',   jsonb_build_object('mode', 'review'),
    'lifetime_max', 6
  )
)
where id = 1 and not (needs_attention_rules ? 'automation');

-- ── 6. compute_nudge_candidates() — the facts query ──────────────────────────
--
-- Returns raw facts for every proof structurally eligible for the
-- sent_never_viewed auto path: in_progress, HS-linked, current version has
-- zero non-bot views. Deliberately does NOT consume proofs_needing_attention()
-- — that function collapses to one highest-priority rule per proof, which
-- would let a higher-priority rule (e.g. the Phase 2b follow-up tag at
-- priority 2) silently mask the auto rule. Decisions (threshold, cap,
-- cooldown, grace, working hours, sibling grouping) happen in the edge
-- function's tested decision module; this returns the inputs.
--
-- send_evidence_at: the spec's send-evidence anchor —
-- coalesce(version.last_reply_sent_at, proof.helpscout_last_reply_at).
-- Null means no evidence the customer was ever sent this version; the
-- decision module fails toward silence (no auto-nudge).
--
-- SECURITY INVOKER, EXECUTE for service_role only: this is the scheduler's
-- private input, not a designer-facing API.

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
  auto_nudge_disabled boolean
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
    p.auto_nudge_disabled_at is not null
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

-- ── 7. nudge_cap_rows() — the structural dry-run exclusion ──────────────────
--
-- The single read path for cap/cooldown maths: every ledger row that counts
-- toward spacing and caps. dry_run rows are excluded BY DEFINITION here, not
-- by a query convention each caller must remember (spec: "structural, not a
-- query convention"). 'sending' and 'sent' both count so a crashed claim
-- cannot be spent twice; manual rows count so human touches always delay
-- automation.

create or replace function proofs.nudge_cap_rows()
returns table (
  proof_id uuid,
  proof_version_id uuid,
  rule_code text,
  source text,
  state text,
  sent_date date,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  -- Truth table kept IDENTICAL to capRows() in
  -- supabase/functions/_shared/nudgeDecision.ts (the copy the sender actually
  -- runs; this SQL twin serves analytics/reporting reads): a row counts iff
  -- state is 'sending' or 'sent', regardless of source. Change one, change
  -- both.
  select n.proof_id, n.proof_version_id, n.rule_code, n.source, n.state,
         n.sent_date, n.created_at
  from proofs.proof_nudges n
  where n.state in ('sending', 'sent')
$$;

revoke execute on function proofs.nudge_cap_rows() from anon, public;
grant execute on function proofs.nudge_cap_rows() to authenticated, service_role;

-- ── 7b. Human-action RPCs: clearing a crashed run / resolving a stuck claim ──
--
-- authenticated has SELECT-only on nudge_runs and proof_nudges, but the spec
-- commits two human actions: clearing a crashed run (an open row gates live
-- sends until a human looks) and resolving a stale 'sending' claim (was the
-- email actually delivered before the crash?). Both go through narrow
-- SECURITY DEFINER RPCs so the ledger stays append-only for everything else.

create or replace function proofs.resolve_nudge_run(p_run_id uuid, p_note text default null)
returns boolean
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  update proofs.nudge_runs
  set finished_at = now(),
      note = trim(coalesce(note || ' · ', '') || 'cleared by a designer'
        || coalesce(': ' || nullif(trim(p_note), ''), ''))
  where id = p_run_id and finished_at is null
  returning true
$$;

-- p_delivered: true → the crashed send DID reach Help Scout (designer checked
-- the thread) → state 'sent'; false → it never went → 'failed'. Only stale
-- 'sending' rows are touchable; everything else is immutable from the client.
create or replace function proofs.resolve_stuck_nudge(p_nudge_id uuid, p_delivered boolean)
returns boolean
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  update proofs.proof_nudges
  set state = case when p_delivered then 'sent' else 'failed' end,
      outcome = case when p_delivered
        then 'sent (confirmed by a designer after a crashed run)'
        else 'failed: confirmed unsent by a designer after a crashed run' end
  where id = p_nudge_id
    and state = 'sending'
    and created_at < now() - interval '15 minutes'
  returning true
$$;

revoke execute on function proofs.resolve_nudge_run(uuid, text) from anon, public;
revoke execute on function proofs.resolve_stuck_nudge(uuid, boolean) from anon, public;
grant execute on function proofs.resolve_nudge_run(uuid, text) to authenticated, service_role;
grant execute on function proofs.resolve_stuck_nudge(uuid, boolean) to authenticated, service_role;

-- ── 8. nudge_outcomes — the analytics view ───────────────────────────────────
--
-- Per ledger row: the first non-bot view and first customer action AFTER the
-- nudge, for the response-rate / open-rate metrics and the dry-run baseline
-- comparison. helpscout_last_customer_reply_at only stores the latest reply,
-- so customer_replied_after is an approximation (true iff the latest reply
-- postdates the nudge). security_invoker so designer RLS context applies;
-- authenticated has SELECT on every underlying table.

create or replace view proofs.nudge_outcomes
with (security_invoker = on) as
select
  n.id as nudge_id,
  n.proof_id,
  n.proof_version_id,
  n.rule_code,
  n.source,
  n.state,
  n.outcome,
  n.sent_date,
  n.created_at,
  (
    select min(v.viewed_at) from proofs.proof_version_views v
    where v.proof_version_id = n.proof_version_id
      and v.is_bot = false
      and v.viewed_at > n.created_at
  ) as first_view_after,
  (
    select min(pe.created_at) from proofs.proof_events pe
    where pe.proof_version_id = n.proof_version_id
      and pe.event_type in ('approve', 'request_changes')
      and pe.created_at > n.created_at
  ) as first_action_after,
  (p.helpscout_last_customer_reply_at > n.created_at) as customer_replied_after
from proofs.proof_nudges n
join proofs.proofs p on p.id = n.proof_id;

revoke all on proofs.nudge_outcomes from anon, public;
grant select on proofs.nudge_outcomes to authenticated;
