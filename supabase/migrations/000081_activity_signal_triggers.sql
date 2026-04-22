-- Migration 000081: bump proofs.last_activity_at from downstream activity
--
-- Closes the signal gap flagged in 000080: today the only path that
-- bumps proofs.last_activity_at is bump_proof_activity on
-- proof_versions INSERT/UPDATE. That means customer views, name
-- approvals, and image-only edits don't wake dormant proofs.
--
-- Three new AFTER triggers, one per source table, each resolving
-- the parent proof via proof_versions.proof_id and bumping
-- last_activity_at. The downstream chain is:
--
--   INSERT into source table → bump trigger fires → UPDATE proofs
--   set last_activity_at = now() → proofs_wake_on_activity
--   (BEFORE UPDATE, from 000080) sees dormant + activity change,
--   flips status to in_progress, writes proof.woke_from_dormant
--   audit entry.
--
-- No audit entries from these triggers themselves — the wake
-- chain handles that when the proof was dormant. For in_progress
-- proofs, the bump is silent (just a timestamp update).
--
-- SECURITY DEFINER is necessary. proof_version_views is written
-- from anon context (record_proof_view RPC); anon has no UPDATE
-- policy on proofs. The trigger functions elevate to run as the
-- owner so they can bypass proofs RLS for the bump.
-- search_path pinned to public, standard hardening for
-- SECURITY DEFINER.
--
-- Deliberately excluded:
--   * DELETE on proof_name_approvals — orphan reconciliation from
--     000078 fires DELETE on automated cleanup, which shouldn't
--     wake a dormant proof. If "Clear approval" should count as
--     activity, handle at the app layer.
--   * UPDATE on proofs itself — status changes / Reopen / Help
--     Scout edits. Trickier because we'd need to exclude the
--     dormancy cron's writes and the wake trigger's status flip.
--     Worth observing the three triggers below in practice first.

begin;

-- ── Shared helper ────────────────────────────────────────────────────────────
-- Single join site; each per-table trigger just resolves the
-- version_id and calls through. Lookup via proof_versions returns
-- null for already-deleted versions (cascade ordering) in which
-- case the UPDATE matches zero rows and is a cheap no-op — safe.

create or replace function bump_proof_activity_by_version(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update proofs
  set last_activity_at = now()
  where id = (select proof_id from proof_versions where id = p_version_id);
end;
$$;

-- ── proof_version_views — AFTER INSERT ───────────────────────────────────────
-- Customer page views wake dormant proofs. WHEN gate skips
-- is_bot=true rows so link unfurlers and crawlers don't generate
-- spurious wake events or audit entries. is_bot is stamped
-- server-side by record_proof_view (migration 000072) via UA
-- regex, so the gate is trustworthy.

create or replace function bump_activity_on_view()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bump_proof_activity_by_version(new.proof_version_id);
  return new;
end;
$$;

create trigger proof_version_views_bump_activity
  after insert on proof_version_views
  for each row
  when (not new.is_bot)
  execute function bump_activity_on_view();

-- ── proof_name_approvals — AFTER INSERT OR UPDATE ────────────────────────────
-- DELETE deliberately NOT covered (see header).

create or replace function bump_activity_on_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bump_proof_activity_by_version(new.proof_version_id);
  return new;
end;
$$;

create trigger proof_name_approvals_bump_activity
  after insert or update on proof_name_approvals
  for each row execute function bump_activity_on_approval();

-- ── proof_version_images — AFTER INSERT OR UPDATE OR DELETE ──────────────────
-- coalesce(new, old) handles the DELETE case where new is null.
-- When DELETE arrives via a proof_versions cascade, the parent
-- version is already gone by the time AFTER fires here; the
-- helper's inner select returns null and the update no-ops.
-- Direct image DELETE (e.g. designer removing an image on the
-- edit form) leaves the parent version intact and bumps normally.

create or replace function bump_activity_on_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_id uuid;
begin
  v_version_id := coalesce(new.proof_version_id, old.proof_version_id);
  perform bump_proof_activity_by_version(v_version_id);
  return coalesce(new, old);
end;
$$;

create trigger proof_version_images_bump_activity
  after insert or update or delete on proof_version_images
  for each row execute function bump_activity_on_image();

commit;
