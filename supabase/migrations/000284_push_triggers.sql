-- 000284: wire customer actions to push notifications via database triggers.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- Why triggers (not an edit to proof-action): proof-action is the ~1700-line
-- live customer-approval function, and the deploy path requires reproducing its
-- whole source by hand. Firing the push from a database trigger keeps that
-- function UNTOUCHED — the push wiring lives entirely in this reviewable SQL.
--
-- Two triggers call the send-push edge function via pg_net, fire-and-forget:
--   * proof_events  AFTER INSERT, event_type = 'request_changes'
--       -> event_code 'customer_requests_changes'
--   * proofs        AFTER UPDATE OF status, status newly 'approved'
--       -> event_code 'project_reaches_approved_status'
--
-- That covers the two highest-value moments (a customer asks for changes; a
-- proof is fully signed off) with no double-fire: a finalising approval flips
-- proofs.status (the second trigger), while the per-recipient approve event on
-- proof_events is deliberately NOT pushed here. Per-recipient approve, email
-- replies, and order events are left for a later pass.
--
-- Auth: send-push (v2) accepts the service-role key OR settings.push_internal_secret.
-- The triggers can't read the service-role key, so they read the internal secret
-- (admin-only column) and present it. Both are server-only.
--
-- Functions are SECURITY DEFINER (so they can read the admin-only settings row
-- regardless of who triggered the action) with search_path pinned, EXECUTE
-- revoked from callers (triggers fire regardless of EXECUTE — house pattern,
-- 000182). Each gated on settings.push_enabled so they're inert until go-live.

begin;

-- Internal secret send-push checks. Generated in-DB (no hardcoded secret in
-- source); the `is null` guard makes re-runs a no-op.
alter table proofs.settings add column if not exists push_internal_secret text;

update proofs.settings
  set push_internal_secret =
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  where id = 1 and push_internal_secret is null;

-- The project's own send-push endpoint.
-- (Hardcoded project ref — this is the proofs project's functions host.)

-- ── Trigger 1: customer requests changes ─────────────────────────────────────
create or replace function proofs.notify_push_on_proof_event()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled  boolean;
  v_secret   text;
  v_proof_id uuid;
begin
  if new.event_type <> 'request_changes' then
    return new;
  end if;

  select push_enabled, push_internal_secret
    into v_enabled, v_secret
  from proofs.settings where id = 1;

  if not coalesce(v_enabled, false) or v_secret is null then
    return new;  -- kill switch off → stay inert (no wasted HTTP call)
  end if;

  select proof_id into v_proof_id
  from proofs.proof_versions where id = new.proof_version_id;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'event_code', 'customer_requests_changes',
      'proof_id', v_proof_id,
      'proof_version_id', new.proof_version_id,
      'source_kind', 'proof_event',
      'source_event_id', new.id::text,
      'vars', jsonb_build_object(
        'actor', coalesce(new.actor_name, 'A customer'),
        'comment', coalesce(new.comment, ''),
        'recipient', case when new.name = '__shared__' then '' else coalesce(new.name, '') end
      )
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_proof_event() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_proof_event() to service_role;

drop trigger if exists notify_push_on_proof_event on proofs.proof_events;
create trigger notify_push_on_proof_event
  after insert on proofs.proof_events
  for each row execute function proofs.notify_push_on_proof_event();

-- ── Trigger 2: proof reaches fully-approved ──────────────────────────────────
create or replace function proofs.notify_push_on_proof_approved()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
  if new.status <> 'approved' or old.status is not distinct from 'approved' then
    return new;
  end if;

  select push_enabled, push_internal_secret
    into v_enabled, v_secret
  from proofs.settings where id = 1;

  if not coalesce(v_enabled, false) or v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'event_code', 'project_reaches_approved_status',
      'proof_id', new.id,
      'source_kind', 'proof_finalize',
      -- cycle discriminator: a re-approval after a reopen gets a fresh key
      'source_event_id', new.id::text || ':' ||
        coalesce(extract(epoch from new.approved_at)::bigint::text, '0')
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_proof_approved() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_proof_approved() to service_role;

drop trigger if exists notify_push_on_proof_approved on proofs.proofs;
create trigger notify_push_on_proof_approved
  after update of status on proofs.proofs
  for each row execute function proofs.notify_push_on_proof_approved();

commit;
