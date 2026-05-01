-- Migration 000129: designer-override audit trail.
--
-- Designer "Mark as approved" on /proofs/:id can flip proof.status to
-- 'approved' even when one or more recipients have an open
-- proof_name_approvals row in state='changes_requested'. Today that
-- override silently overwrites those rows to 'approved' and writes
-- nothing to proof_events, so the dashboard / activity feed has no
-- record that customer feedback was overridden. This migration
-- installs the audit shape; the wiring (handleApprove rewrite + UI)
-- lands in the same prompt's app code commits.
--
-- Two coordinated schema changes:
--
--   1. proof_events.event_type CHECK widened to admit
--      'designer_override_approve'. The 000116 header anticipated
--      this exact path: text-with-CHECK was chosen over a Postgres
--      enum precisely so future event types can be added without a
--      type migration.
--
--   2. proof_name_approvals gains three nullable columns:
--      overridden_from_state, overridden_by_user_id, overridden_at.
--      Stored on the row so the names roll-up can render
--      "(originally requested changes)" without joining proof_events,
--      which keeps the read path identical to today's pattern. Null
--      in the steady state — the override flow is the rare path.
--
-- No data backfill: there are no existing override events to record
-- (the override path was silent until now, and we deliberately don't
-- invent provenance for historic flips we can't reliably attribute).
--
-- Idempotent: each block uses IF NOT EXISTS / IF EXISTS guards so
-- re-applying the migration is a no-op.

begin;

-- ── 1. proof_events.event_type — widen CHECK ─────────────────────────
--
-- The 000116 inline CHECK assigned the implicit name
-- proof_events_event_type_check. Drop and recreate to add
-- 'designer_override_approve'. Future event types should be added
-- to the IN list here — the dashboard activity feed and the
-- customer-page event reducer both branch on event_type and will
-- need updates when new types land. Customer-driven actions
-- (approve / request_changes) and designer-driven audit actions
-- (designer_override_approve) sit in the same table because they
-- share the same per-recipient shape and feed the same visual
-- timeline; the type discriminates rendering and read filters.

alter table proof_events
  drop constraint if exists proof_events_event_type_check;

alter table proof_events
  add constraint proof_events_event_type_check
  check (event_type in (
    'approve',
    'request_changes',
    'designer_override_approve'
  ));

comment on column proof_events.event_type is
  'CHECK-constrained: approve | request_changes | '
  'designer_override_approve. The first two are customer-initiated '
  'via the proof-action edge function. designer_override_approve is '
  'written by ProofDetailPage.handleApprove() when "Mark as '
  'approved" flips a row that was in changes_requested — the '
  'designer dashboard distinguishes these from customer-driven '
  'approvals for audit-trail integrity. Future event types extend '
  'this list (text-with-CHECK over enum was a 000116 decision '
  'specifically to keep that cheap).';

-- ── 2. proof_name_approvals — override provenance columns ────────────
--
-- Three columns recording an override on the row itself. Reading the
-- override state from the row (rather than from a join against
-- proof_events) keeps the names-rollup query identical to today's
-- pattern and avoids a second round-trip on a hot read path.
--
--   overridden_from_state  — the state the row held immediately
--     before the override. CHECK restricts to the one origin state
--     that exists in production today: 'changes_requested'. If new
--     pre-approval states are added later (e.g. 'pending',
--     'withdrawn'), this CHECK needs widening alongside the
--     proof_name_approvals.state CHECK from 000076. Null = not an
--     override (the steady-state value).
--
--   overridden_by_user_id  — auth.users(id) of the designer who hit
--     "Mark as approved". ON DELETE SET NULL so deleting an auth user
--     doesn't cascade-drop the override audit. Nullable for
--     non-override rows.
--
--   overridden_at          — when the override was recorded. Nullable
--     for non-override rows. Distinct from updated_at (which bumps
--     on every state change) so the override timestamp is preserved
--     across any subsequent updates to the same row.

alter table proof_name_approvals
  add column if not exists overridden_from_state text null;

alter table proof_name_approvals
  add column if not exists overridden_by_user_id uuid null
    references auth.users(id) on delete set null;

alter table proof_name_approvals
  add column if not exists overridden_at timestamptz null;

alter table proof_name_approvals
  drop constraint if exists proof_name_approvals_overridden_from_state_check;

alter table proof_name_approvals
  add constraint proof_name_approvals_overridden_from_state_check
  check (
    overridden_from_state is null
    or overridden_from_state in ('changes_requested')
  );

comment on column proof_name_approvals.overridden_from_state is
  'When non-null, this row was flipped to state=''approved'' by a '
  'designer override (ProofDetailPage.handleApprove) and held the '
  'recorded prior state immediately before the flip. CHECK '
  'restricts values to ''changes_requested'' — the only pre-approval '
  'state that exists today. If new pre-approval states are added '
  '(pending, withdrawn, etc.) this CHECK and the proof_name_'
  'approvals.state CHECK from 000076 both need widening. Null in '
  'the steady state — overrides are the rare path.';

comment on column proof_name_approvals.overridden_by_user_id is
  'auth.users(id) of the designer who recorded the override. ON '
  'DELETE SET NULL so deleting a designer auth user retains the '
  'override audit (the row keeps overridden_from_state and '
  'overridden_at; only attribution detaches). Null for non-override '
  'rows. Mirrored by a proof_events row with event_type='
  '''designer_override_approve'' written in the same handleApprove '
  'transaction.';

comment on column proof_name_approvals.overridden_at is
  'Timestamp the override was recorded. Distinct from updated_at, '
  'which bumps on every state change. Preserved across any '
  'subsequent updates to the same row so the original override '
  'moment stays auditable.';

commit;
