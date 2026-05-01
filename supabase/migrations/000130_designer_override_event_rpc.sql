-- Migration 000130: SECURITY DEFINER RPC for designer override events.
--
-- PR #6 (000129) added a designer_override_approve event_type and
-- wired ProofDetailPage.handleApprove to insert proof_events rows
-- when a designer overrides one or more open changes_requested rows.
-- The insert was rejected silently by RLS — proof_events has no
-- INSERT policy for any non-service role per 000116. End-to-end
-- testing on Test Customer S4 caught the regression: the override
-- row on proof_name_approvals landed (no RLS gate there) but the
-- matching proof_events row didn't, leaving the dashboard activity
-- feed without a slate row and the customer page leaking the older
-- request_changes event metadata onto the approved pill.
--
-- This migration mirrors the audit_log pattern from 000043: a
-- SECURITY DEFINER RPC stamps the actor server-side from
-- auth.uid()/auth.users.email and bypasses RLS for the actual
-- insert. That's stronger than a direct INSERT policy with
-- WITH CHECK (event_type='designer_override_approve') because the
-- direct policy would let any authenticated designer spoof
-- actor_name on a fabricated override event (impersonating another
-- designer or a customer). The RPC closes that — actor_name is
-- stamped from auth.users.email, not accepted from the caller.
--
-- Scope is intentionally narrow: this RPC exists only for
-- designer_override_approve events. Customer-driven approve /
-- request_changes events keep flowing through the proof-action
-- edge function via service role per the established pattern.
--
-- One row per call, mirroring log_audit_event's shape.
-- ProofDetailPage.handleApprove invokes the RPC in a loop over
-- override rows (typical N=1-3, capped by recipient count).

begin;

create or replace function log_designer_override_event(
  p_proof_version_id uuid,
  p_name             text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid;
  v_email    text;
  v_id       uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'log_designer_override_event requires an authenticated caller';
  end if;

  select u.email::text
    into v_email
    from auth.users u
   where u.id = v_actor_id;

  if v_email is null then
    raise exception 'log_designer_override_event: no email on auth.users for %', v_actor_id;
  end if;

  -- proof_events.actor_name is text NOT NULL; email is the same
  -- attribution shape the rest of handleApprove uses (PR #6) so
  -- the dashboard feed and rollup render consistently.
  --
  -- material_option_code stays null — an override is whole-row,
  -- not option-tab-scoped. The 000124 trigger documents null as
  -- the "not applicable" semantic and short-circuits its
  -- membership check on null input.
  insert into proof_events (
    proof_version_id,
    event_type,
    actor_name,
    name,
    comment,
    from_ip,
    from_ua,
    helpscout_thread_id,
    pricing_snapshot_at_action,
    material_option_code
  ) values (
    p_proof_version_id,
    'designer_override_approve',
    v_email,
    p_name,
    null,
    null,
    null,
    null,
    null,
    null
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function log_designer_override_event(uuid, text) to authenticated;

comment on function log_designer_override_event(uuid, text) is
  'SECURITY DEFINER RPC for inserting a designer_override_approve '
  'row into proof_events. Stamps actor_name from auth.users.email '
  'server-side so the caller cannot spoof attribution. Called from '
  'ProofDetailPage.handleApprove once per overridden recipient. '
  'Mirrors the log_audit_event pattern from 000043. Designer '
  'override is the only event_type that flows through this RPC; '
  'customer-driven approve / request_changes events stay on the '
  'proof-action edge function via service role.';

commit;
