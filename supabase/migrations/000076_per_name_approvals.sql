-- Migration 000076: per-name approvals
--
-- Lays the data structure for customer approval broken down by recipient
-- name, instead of the coarser version-level approval we never shipped.
--
-- Context:
--   * Migration 000066 added four approval-capture columns to
--     proof_versions (approved_at, approved_by_name, approved_from_ip,
--     approved_from_ua). The plan was to wire an "Approve this version"
--     button on the customer page. That plan never shipped — the columns
--     sit unused (no reads, no writes, no coverage in
--     public_proof_versions per Discovery).
--   * Split-name projects (migration 000070) print a version for N
--     recipients at once. One "this whole version is approved" flag is
--     too blunt for that flow — we want each recipient to sign off on
--     their own card, and a single blocker shouldn't gate the rest.
--
-- This migration just sets up the storage. No UI, no RPC, no triggers,
-- no Help Scout hooks. Later PRs wire the customer-facing action.
--
-- public_proof_versions does NOT reference any of the four dropped
-- columns (verified via pg_get_viewdef), so drop column if exists is
-- safe without touching the view.

begin;

-- ── 1. Drop the four unused version-level approval columns ──────────────────
-- approved_while_superseded (also on proof_versions, migration 000068) is
-- deliberately NOT dropped — it's a separate audit flag documenting
-- whether a version was approved after being superseded, and stays.

alter table proof_versions drop column if exists approved_at;
alter table proof_versions drop column if exists approved_by_name;
alter table proof_versions drop column if exists approved_from_ip;
alter table proof_versions drop column if exists approved_from_ua;

-- ── 2. Per-name approvals table ─────────────────────────────────────────────
-- One row per (proof_version, recipient name) pair. Unique constraint
-- enforces one active approval record per name per version; the later
-- UI will upsert into this table when a recipient acts.
--
-- `name` is plain text, deliberately NOT FK'd — it matches the free-text
-- pattern already established for proof_version_images.associated_name
-- (migration 000071). proof_versions.names is a text[] snapshot with no
-- target table, and the approval record should outlive any post-hoc
-- chip-list edits for audit purposes. Orphan reconciliation (if a name
-- is later removed from the version's chip list) is UI-layer work and
-- not handled here.
--
-- actor_name, actor_ip, actor_ua capture who approved from where for
-- audit. Only actor_name is mandatory — the IP and UA come via
-- request.headers in the later RPC and can be absent for tests or
-- direct-DB admin corrections.
--
-- state carries either 'approved' or 'changes_requested'. When
-- 'changes_requested', change_request is expected to hold the
-- recipient's note back to the designer. CHECK constraint enforces the
-- enum shape; no CHECK on change_request since both states can
-- legitimately have or lack a note.

create table proof_name_approvals (
  id                uuid primary key default gen_random_uuid(),
  proof_version_id  uuid not null references proof_versions(id) on delete cascade,
  name              text not null,
  state             text not null check (state in ('approved', 'changes_requested')),
  change_request    text,
  actor_name        text not null,
  actor_ip          text,
  actor_ua          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (proof_version_id, name)
);

comment on table proof_name_approvals is
  'Per-recipient approval state for a proof version. One row per '
  '(version, recipient name). Populated via a later customer-facing '
  'action; no UI touches this table yet.';

comment on column proof_name_approvals.name is
  'Recipient name drawn from proof_versions.names snapshot. Plain text, '
  'no FK — matches proof_version_images.associated_name convention '
  '(migration 000071).';

comment on column proof_name_approvals.state is
  '''approved'' or ''changes_requested''. Constrained by CHECK — extend '
  'here when adding a third state.';

-- ── 3. RLS ─────────────────────────────────────────────────────────────────
-- Mirrors the permissive SELECT/INSERT/UPDATE + admin-only DELETE pattern
-- established by migration 000074 for companies / contacts / proofs. The
-- customer RPC that will later target this table runs as
-- authenticated via supabase-js on the public page; admin deletes cover
-- correction / cleanup flows.

alter table proof_name_approvals enable row level security;

create policy "proof_name_approvals: authenticated read"
  on proof_name_approvals for select to authenticated
  using (true);

create policy "proof_name_approvals: authenticated insert"
  on proof_name_approvals for insert to authenticated
  with check (true);

create policy "proof_name_approvals: authenticated update"
  on proof_name_approvals for update to authenticated
  using (true) with check (true);

create policy "proof_name_approvals: admin delete"
  on proof_name_approvals for delete to authenticated
  using (is_admin());

commit;
