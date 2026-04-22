-- Migration 000080: auto-archive dormant proofs (90-day threshold + audit)
--
-- Replaces the 30-day mark_dormant_proofs() + its cron job from
-- migration 000019. Key changes:
--   * Threshold raised 30 → 90 days
--   * Both directions (forward flip to dormant, reverse flip on
--     activity) now write to audit_log
--   * Reverse flip moved from proof_versions trigger to proofs
--     trigger so any future path that bumps last_activity_at will
--     wake a dormant proof, not just version events
--
-- The existing bump_proof_activity trigger on proof_versions stays
-- in place — it still bumps last_activity_at + inline-flips status
-- to in_progress on version events, which is additively safe. The
-- new proofs-level trigger catches whatever the version trigger
-- emits (status flip is idempotent — same value) and adds audit,
-- plus covers any other path that updates last_activity_at on
-- proofs directly (hypothetical; no such path exists today but
-- defensive against future additions).
--
-- Activity-signal gap worth flagging for a separate follow-up:
-- today only proof_versions INSERT/UPDATE bumps last_activity_at.
-- Customer views, name approvals, project status changes, and
-- Help Scout link edits do NOT bump. Dormant proofs won't wake
-- from those actions. Not fixed here — each requires an explicit
-- bump call at the relevant write site.

begin;

-- ── 1. Tear down the 30-day job + function ──────────────────────────────────

-- Guard unschedule in case this migration is re-applied or the job
-- was already removed by hand. cron.unschedule accepts a jobname
-- as of pg_cron 1.4+ and errors if not found; wrapping in DO
-- keeps it idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mark-dormant-proofs') then
    perform cron.unschedule('mark-dormant-proofs');
  end if;
end $$;

drop function if exists mark_dormant_proofs();

-- ── 2. Forward flip — nightly cron ──────────────────────────────────────────

create or replace function auto_dormant_stale_proofs()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  threshold interval := '90 days';
begin
  -- Flip stale in_progress proofs to dormant, capture which rows
  -- moved so we can write matching audit entries in the same
  -- transaction. NULL last_activity_at is defensively treated as
  -- stale (column is NOT NULL today, but the guard costs nothing).
  with flipped as (
    update proofs
    set status = 'dormant'
    where status = 'in_progress'
      and (last_activity_at is null
           or last_activity_at < now() - threshold)
    returning id, last_activity_at, contact_id
  )
  insert into audit_log (
    actor_id, actor_email, actor_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  )
  select
    null,                -- no authenticated caller in cron context
    null,
    'system',            -- audit viewer-friendly actor label
    'proof.auto_dormant',
    'proof',
    f.id::text,
    (select full_name from contacts where id = f.contact_id),
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object('status', 'dormant'),
    jsonb_build_object(
      'actor_context', 'system_cron',
      'threshold_days', 90,
      'last_activity_at', f.last_activity_at
    )
  from flipped f;
end;
$$;

-- ── 3. Reverse flip — BEFORE UPDATE trigger on proofs ───────────────────────

create or replace function wake_proof_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid;
  v_email    text;
  v_label    text;
begin
  -- Gate: only fire when a dormant row is being updated AND
  -- last_activity_at is the column changing. Ignores no-op UPDATEs
  -- and status-only cron flips (the cron writes status without
  -- touching last_activity_at, so this condition is false there —
  -- no self-trigger loop).
  if old.status <> 'dormant'
     or new.last_activity_at is not distinct from old.last_activity_at
  then
    return new;
  end if;

  -- Flip status. BEFORE trigger so the status mutation rides in
  -- the same UPDATE statement, single row-write.
  new.status := 'in_progress';

  -- Audit entry. actor_id resolves via auth.uid() when the bump
  -- came from an authenticated designer session; null in
  -- service-role or future cron-adjacent contexts. Join
  -- auth.users + profiles for email/label to match the shape of
  -- log_audit_event() RPC writes.
  v_actor_id := auth.uid();
  if v_actor_id is not null then
    select u.email::text, coalesce(p.full_name, u.email::text)
      into v_email, v_label
      from auth.users u
      left join profiles p on p.id = u.id
      where u.id = v_actor_id;
  end if;

  insert into audit_log (
    actor_id, actor_email, actor_label,
    action, target_type, target_id, target_label,
    before_value, after_value, metadata
  )
  values (
    v_actor_id,
    v_email,
    coalesce(v_label, 'system'),
    'proof.woke_from_dormant',
    'proof',
    new.id::text,
    (select full_name from contacts where id = new.contact_id),
    jsonb_build_object('status', 'dormant'),
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'actor_context', case when v_actor_id is null then 'system' else 'user' end,
      'activity_bumped_at', new.last_activity_at
    )
  );

  return new;
end;
$$;

create trigger proofs_wake_on_activity
  before update on proofs
  for each row
  execute function wake_proof_on_activity();

-- ── 4. Schedule the cron ────────────────────────────────────────────────────

select cron.schedule(
  'auto-dormant-stale-proofs',
  '0 3 * * *',  -- 03:00 UTC nightly
  $$select auto_dormant_stale_proofs();$$
);

commit;
