-- Migration 000116: Phase 2 customer approval flow — schema foundation.
--
-- Phase 1 shipped a read-only customer proof page. Phase 2 adds an
-- Approve / Request changes flow on that page so the customer can act
-- on a proof without going through email. This migration is the first
-- of several commits and contains schema only; no application code
-- yet reads or writes any of the new objects.
--
-- ── Settings: three new columns on the singleton ─────────────────────
--
--   approvals_enabled                   — global gate. Defaults false
--     so the flow ships dark and is flipped on once Rob is ready to
--     test with a real customer. While false the customer page renders
--     Phase 1 chrome unchanged. Same kill-switch idiom as
--     replies_enabled (000104).
--
--   approve_confirmation_copy           — modal body copy shown when
--     the customer clicks Approve. Editable from Admin → Settings so
--     wording can be tuned without a code deploy.
--
--   request_changes_confirmation_copy   — modal body copy shown when
--     the customer clicks Request changes. Same editability rationale.
--
-- All three use ADD COLUMN IF NOT EXISTS so re-applying this migration
-- is a no-op.
--
-- ── proof_events: append-only event log ──────────────────────────────
--
-- The customer's action lands here. Append-only by design — the row is
-- the source of truth for "this customer approved v3 at 14:02 on
-- 2026-05-12 from IP X". The four legacy approval columns added by
-- 000066 (approved_at / approved_by_name / approved_from_ip /
-- approved_from_ua) become vestigial after Phase 2 ships and will be
-- dropped in a future cleanup migration once nothing reads them.
--
-- Schema notes:
--   * event_type is a CHECK-constrained enum-by-text so we can extend
--     it later (e.g. 'reopen', 'cancel') without a type migration.
--   * comment is nullable. Required-for-request_changes is enforced at
--     the application layer (customer page validation + edge function
--     re-validation) rather than in the schema, so a future "approve
--     with note" path doesn't need a schema change.
--   * helpscout_thread_id nullable. Populated when the edge function
--     successfully posts a Help Scout note alongside the event. Null
--     means "event recorded but HS notification failed" — the dashboard
--     will surface this as a warning.
--   * total_price_at_action / currency_at_action snapshot the live
--     price the customer saw at the moment they acted. This is the
--     audit field that makes the deliberate flip (below) safe.
--   * No UNIQUE constraint on proof_version_id. The "one event per
--     version" rule is enforced at the UI layer (the page becomes
--     read-only once an event exists), keeping the schema flexible if
--     that rule ever changes.
--   * No action-window expiry column. The 90-day window proposed in
--     early Phase 2 sketches has been dropped — live pricing (below)
--     makes a stale-pricing approval impossible, so any-age action is
--     safe.
--
-- ── Pricing model flip (subsequent commit) ───────────────────────────
--
-- The customer-page commit later in Phase 2 will switch the pricing
-- read from proof_versions.pricing_snapshot to a live join against
-- price_tiers. This is a deliberate commercial choice: customers will
-- see today's prices, not the prices captured at version creation.
-- pricing_snapshot stays on the table as a historical record (and as
-- the source for total_price_at_action when the customer acts), but
-- it stops being the customer-facing display. The note in 000106's
-- header ("historical proofs are protected by the pricing_snapshot
-- model") becomes outdated at that point — by design, not by accident.
-- This migration does not touch pricing_snapshot.
--
-- ── RLS ──────────────────────────────────────────────────────────────
--
-- Designers (authenticated): SELECT all rows — same idiom as
-- proof_versions (000010/000011).
--
-- Service role: bypasses RLS by default in Supabase, so no explicit
-- INSERT policy is needed. The Phase 2 edge function will write events
-- via service role, matching the audit_log pattern (000043).
--
-- Anon: no direct table access. The customer page will read events
-- through an extension to the public_proof_versions view in a later
-- commit; this migration does not change that view.
--
-- No UPDATE or DELETE policies for any role — the table is append-only
-- by absence of policy, not by trigger.

begin;

-- ── 1. Settings columns ──────────────────────────────────────────────

alter table settings
  add column if not exists approvals_enabled boolean not null default false;

alter table settings
  add column if not exists approve_confirmation_copy text not null default
    'By approving, you''re confirming that you''ve reviewed the proof and we''re cleared to print as shown. Approval is final and triggers production scheduling.';

alter table settings
  add column if not exists request_changes_confirmation_copy text not null default
    'We''ll update your proof based on your feedback. The team will reply within one working day.';

comment on column settings.approvals_enabled is
  'Global gate for the Phase 2 customer Approve / Request changes flow. '
  'False (default) renders the Phase 1 read-only customer page; true '
  'reveals the action buttons. Mirrors the replies_enabled (000104) '
  'kill-switch idiom — flip from Admin → Settings, propagates within '
  'one settings-cache TTL (60s) without a code deploy.';

comment on column settings.approve_confirmation_copy is
  'Modal body copy shown when the customer clicks Approve. Editable '
  'from Admin → Settings so wording can be tuned without redeploy.';

comment on column settings.request_changes_confirmation_copy is
  'Modal body copy shown when the customer clicks Request changes. '
  'Editable from Admin → Settings so wording can be tuned without '
  'redeploy.';

-- ── 2. proof_events table ────────────────────────────────────────────

create table if not exists proof_events (
  id                       uuid        primary key default gen_random_uuid(),
  proof_version_id         uuid        not null references proof_versions(id) on delete cascade,
  event_type               text        not null check (event_type in ('approve', 'request_changes')),
  actor_name               text        not null,
  comment                  text,
  from_ip                  inet,
  from_ua                  text,
  helpscout_thread_id      text,
  total_price_at_action    numeric,
  currency_at_action       text,
  created_at               timestamptz not null default now()
);

comment on table proof_events is
  'Append-only log of customer actions on proof versions (Phase 2 '
  'approval flow). Source of truth for "this customer approved v3 '
  'at 14:02 from IP X". The four legacy approved_* columns on '
  'proof_versions (000066) become vestigial once Phase 2 ships and '
  'will be dropped in a future cleanup migration. No UNIQUE on '
  'proof_version_id — "one event per version" is a UI-layer rule, '
  'not a schema rule.';

comment on column proof_events.event_type is
  'CHECK-constrained: approve | request_changes. Text-with-CHECK '
  'rather than enum so we can extend (reopen, cancel, etc.) without '
  'a type migration.';

comment on column proof_events.comment is
  'Customer''s message. Nullable in the schema — required-for-'
  'request_changes is enforced at the app layer so a future '
  '"approve with note" path doesn''t need a schema change.';

comment on column proof_events.helpscout_thread_id is
  'Populated when the Phase 2 edge function successfully posts a '
  'Help Scout note alongside the event. Null = HS notification '
  'failed; the dashboard surfaces these as a warning.';

comment on column proof_events.total_price_at_action is
  'Live total price the customer saw at the moment they acted, '
  'snapshotted into the event row. Audit field that makes the '
  'snapshot-to-live pricing flip (later Phase 2 commit) safe — the '
  'price the customer agreed to is captured here regardless of any '
  'subsequent price_tiers change.';

comment on column proof_events.currency_at_action is
  'Currency for total_price_at_action. GBP / EUR / USD. Not CHECK-'
  'constrained at the schema level — the writing edge function '
  'validates against the version''s currency.';

-- ── 3. Indexes ───────────────────────────────────────────────────────

create index if not exists proof_events_proof_version_id_idx
  on proof_events (proof_version_id);

create index if not exists proof_events_proof_version_id_created_at_idx
  on proof_events (proof_version_id, created_at desc);

-- ── 4. RLS ───────────────────────────────────────────────────────────

alter table proof_events enable row level security;

-- Designer SELECT — matches the proof_versions idiom from 000010/000011.
-- Wrapped in an existence check so re-applying the migration is a no-op
-- (CREATE POLICY itself is not idempotent).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'proof_events'
      and policyname = 'proof_events: authenticated read'
  ) then
    create policy "proof_events: authenticated read"
      on proof_events for select
      to authenticated
      using (true);
  end if;
end$$;

-- No INSERT policy for any non-service role. Service role bypasses RLS
-- by default; the Phase 2 edge function will write events via service
-- role, matching the audit_log pattern (000043).
--
-- No UPDATE or DELETE policies — table is append-only by absence of
-- policy.

commit;
