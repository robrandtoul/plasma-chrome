-- 000351: record WHICH briefing wrote each AI draft, so an approved rule change
-- can be measured rather than eyeballed.
--
-- proofs.ai_drafts already records the MODEL that wrote a draft. It does not
-- record the BRIEFING. The rule side has provenance — ai_draft_house_rules
-- carries .source and .proposal_id, stamped by apply_ai_draft_proposal — but
-- there is no matching stamp on the output, so nobody can ask "did acceptance
-- actually improve after I approved that change?". All Rob has is a 30-day
-- trend line that drifts for a dozen unrelated reasons (proof-delivery volume,
-- a model swap, who happened to be on the mailbox that week). A rule that made
-- drafts WORSE is currently invisible, and therefore permanent. This closes the
-- return arc: every draft is stamped with the briefing that produced it, and
-- the Drafts panel groups acceptance by that stamp.
--
-- ── Mechanism: a counter, not a hash. Why ────────────────────────────────────
-- There are two honest ways to answer "which briefing is this":
--
--   A HASH over the active rules + exemplars is stateless. It cannot drift out
--   of sync with the tables, because it IS the tables. But it is opaque
--   ("briefing a3f9c1…"), it carries no ordering — you cannot tell which of two
--   hashes came first without going and looking — and reverting an edit quietly
--   reuses an earlier hash, so two separate periods merge into one bucket. It
--   also has to be recomputed over every active row on every single draft.
--
--   A COUNTER is cheap to read (one scalar) and MONOTONIC, so versions sort
--   themselves and read as a plain "briefing v12" that a non-coder can say out
--   loud. The cost is that it is state, which means triggers on both briefing
--   tables covering every path that changes what the drafter sees — and a
--   missed path would let the number silently lie.
--
-- The counter wins, because the whole job here is a BEFORE/AFTER comparison and
-- ordering is what makes that possible. The drift risk is paid down below by
-- covering every DML path: INSERT, DELETE, and the UPDATEs that actually change
-- what the drafter reads. Bookkeeping-only updates (source, proposal_id,
-- updated_at, updated_by) deliberately do NOT bump — a new version with an
-- identical briefing would split one sample into two and understate both.
--
-- The number is an IDENTITY, not a count of edits: a proposal that rewrites
-- three rules bumps it three times. Gaps and jumps are normal and harmless;
-- all that matters is that it changes when the briefing changes and never goes
-- backwards.
--
-- ── Why the trigger function is SECURITY DEFINER ─────────────────────────────
-- Not tidiness — necessity. proofs.settings has RLS with an admin-only UPDATE
-- policy (`settings: admin update`, gated on proofs.is_admin()), while the two
-- briefing tables are open to any authenticated designer (`... _rw` policies,
-- using (true)). A non-admin editing a rule would have its bump blocked by
-- settings' RLS, and the version would stop tracking reality. SECURITY DEFINER
-- makes the bump behave identically whoever fires it. search_path is pinned to
-- the live convention and EXECUTE is revoked per the 000182 sweep — triggers
-- fire regardless of EXECUTE, so nothing needs it granted.
--
-- ── Grants ───────────────────────────────────────────────────────────────────
-- No table grants are restated, and none are needed. Postgres table-level
-- privileges cover columns added later, and both tables already sit where they
-- should (verified read-only against live before writing this):
--   proofs.ai_drafts  — SELECT to authenticated (the admin Drafts panel reads
--                       it), ALL to service_role (the ai-draft function writes
--                       it), nothing to anon.
--   proofs.settings   — SELECT/INSERT/UPDATE/DELETE to authenticated (admin
--                       surface), SELECT/INSERT/UPDATE/DELETE to service_role,
--                       nothing to anon.
-- Restating them would only risk widening something by accident.
--
-- ⚠ Deploy order: MIGRATION FIRST, then the ai-draft edge function. The worker's
-- ledger write names briefing_version, and PostgREST rejects the whole update
-- if the column is missing — which would leave the ledger row stuck mid-flight.
-- The admin Drafts panel reads the new columns too, so the frontend also wants
-- this applied first (its charts sit on "Loading…" otherwise).
--
-- Apply via MCP apply_migration / the dashboard SQL editor per the house
-- workflow — never CLI push.

-- ── 1. The counter itself ────────────────────────────────────────────────────
-- Lives on the settings singleton next to ai_drafts_mode / _model, which is
-- where every other AI-draft dial already is. Starts at 1: there IS a current
-- briefing today, it just has not been named until now.
alter table proofs.settings
  add column if not exists ai_draft_briefing_version integer not null default 1,
  -- When the current version came into force. Deliberately NULL on the existing
  -- row rather than defaulting to now() — the briefing live today did not start
  -- today, and a made-up date is worse than an honest blank. Every future bump
  -- fills it in. Lets the panel say "live since 24 Jul, no drafts yet" instead
  -- of going quiet on a version too new to have written anything.
  add column if not exists ai_draft_briefing_version_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'proofs.settings'::regclass
      and conname = 'settings_ai_draft_briefing_version_check'
  ) then
    alter table proofs.settings
      add constraint settings_ai_draft_briefing_version_check
      check (ai_draft_briefing_version >= 1);
  end if;
end $$;

comment on column proofs.settings.ai_draft_briefing_version is
  'Monotonic id of the current AI-draft briefing (house rules + exemplars). Bumped by trigger whenever an active rule or exemplar changes; stamped onto proofs.ai_drafts.briefing_version. An identity, not an edit count — gaps are normal. Never edit by hand: it is the key the before/after acceptance comparison joins on.';

comment on column proofs.settings.ai_draft_briefing_version_at is
  'When ai_draft_briefing_version last changed. NULL means the current version predates this migration.';

-- ── 2. The stamp on each draft ───────────────────────────────────────────────
-- Nullable, no backfill, on purpose: every row written before today honestly
-- has an unknown briefing, and inventing one would be the exact kind of quiet
-- fiction this feature exists to remove.
--
-- 0 is reserved and means "the compiled TypeScript constants" — the hard
-- fail-safe in _shared/aiDrafts/briefing.ts, used when the DB briefing is
-- unreadable. It is deliberately NOT recorded as version 1: once an admin has
-- edited anything, the code briefing is nobody's live briefing. 0 reads as
-- "before v1", which is exactly what it is.
alter table proofs.ai_drafts
  add column if not exists briefing_version integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'proofs.ai_drafts'::regclass
      and conname = 'ai_drafts_briefing_version_check'
  ) then
    alter table proofs.ai_drafts
      add constraint ai_drafts_briefing_version_check
      check (briefing_version is null or briefing_version >= 0);
  end if;
end $$;

comment on column proofs.ai_drafts.briefing_version is
  'Which briefing wrote this draft: settings.ai_draft_briefing_version at draft time. 0 = the compiled TS fallback briefing (the DB was unreadable). NULL = not recorded — every row before 2026-07-26, and any draft where the version scalar could not be read. Treat NULL as "unknown", never as "the current one".';

-- ── 3. The bump ──────────────────────────────────────────────────────────────
create or replace function proofs.bump_ai_draft_briefing_version()
returns trigger
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_bumped integer;
begin
  update proofs.settings
     set ai_draft_briefing_version = ai_draft_briefing_version + 1,
         ai_draft_briefing_version_at = now()
   where id = 1;

  get diagnostics v_bumped = row_count;

  -- Refuse to let the bump quietly not happen. `where id = 1` updating zero
  -- rows is not an error to Postgres, so without this check a missing settings
  -- singleton would leave the counter frozen while rules kept changing — every
  -- draft after that point stamped with a version that no longer describes the
  -- briefing that wrote it. That is the exact quiet fiction the rest of this
  -- migration is written to avoid (nullable _at rather than a made-up date,
  -- NULL rather than a guessed version, 0 reserved for the code fallback), so
  -- it should not make an exception for itself.
  --
  -- Failing loudly aborts the rule edit that triggered it, which sounds harsh
  -- for a bookkeeping counter. It is the right way round here: there is exactly
  -- one settings row and it is id = 1 (verified against live), and if it ever
  -- went missing the drafter could not read ai_drafts_mode either — the feature
  -- is already down. A blocked edit with a clear message beats a comparison
  -- panel that reads plausibly and is wrong.
  if v_bumped <> 1 then
    raise exception
      'AI-draft briefing version could not be advanced: proofs.settings id = 1 matched % rows (expected 1). The briefing version would silently stop tracking the briefing, so this change has been rolled back.',
      v_bumped
      using errcode = 'no_data_found';
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function proofs.bump_ai_draft_briefing_version() is
  'Trigger helper: advances settings.ai_draft_briefing_version when an AI-draft house rule or exemplar changes. SECURITY DEFINER because settings'' UPDATE policy is admin-only while the briefing tables are open to any authenticated designer.';

-- 000182 pattern: internal plumbing, callable by nothing. Trigger invocation
-- ignores EXECUTE, so revoking it costs nothing and shrinks the API surface.
revoke all on function proofs.bump_ai_draft_briefing_version() from public, anon, authenticated;

-- ── 4. Every path that changes what the drafter reads ────────────────────────
-- INSERT and DELETE always count. UPDATE counts only when a column the drafter
-- actually sees moved — rule/exemplar text, is_active (a deactivated rule is
-- gone from the prompt), and sort_order (the order rules are presented in).
drop trigger if exists ai_draft_house_rules_briefing_version_ins_del on proofs.ai_draft_house_rules;
create trigger ai_draft_house_rules_briefing_version_ins_del
  after insert or delete on proofs.ai_draft_house_rules
  for each row execute function proofs.bump_ai_draft_briefing_version();

drop trigger if exists ai_draft_house_rules_briefing_version_upd on proofs.ai_draft_house_rules;
create trigger ai_draft_house_rules_briefing_version_upd
  after update on proofs.ai_draft_house_rules
  for each row
  when (
    old.rule_text  is distinct from new.rule_text
    or old.is_active  is distinct from new.is_active
    or old.sort_order is distinct from new.sort_order
  )
  execute function proofs.bump_ai_draft_briefing_version();

drop trigger if exists ai_draft_exemplars_briefing_version_ins_del on proofs.ai_draft_exemplars;
create trigger ai_draft_exemplars_briefing_version_ins_del
  after insert or delete on proofs.ai_draft_exemplars
  for each row execute function proofs.bump_ai_draft_briefing_version();

drop trigger if exists ai_draft_exemplars_briefing_version_upd on proofs.ai_draft_exemplars;
create trigger ai_draft_exemplars_briefing_version_upd
  after update on proofs.ai_draft_exemplars
  for each row
  when (
    old.category      is distinct from new.category
    or old.customer_text is distinct from new.customer_text
    or old.reply_text    is distinct from new.reply_text
    or old.is_active     is distinct from new.is_active
    or old.sort_order    is distinct from new.sort_order
  )
  execute function proofs.bump_ai_draft_briefing_version();

-- Note on TRUNCATE: not covered, and deliberately. Nothing in the app or in any
-- migration truncates these tables (000225's idempotent re-seed uses DELETE,
-- which the triggers above do catch). A statement-level truncate trigger would
-- be the only way, and adding one for a path that does not exist buys nothing.
