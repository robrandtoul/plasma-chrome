-- 000294: push notification when a project is flagged onto the board.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration. Do NOT use `supabase db push`.
--
-- Fires the existing send-push fan-out on every proofs.watch_items insert —
-- manual flags AND complaint auto-flags — so a flagged problem isn't silent.
-- Same trigger pattern as 000284/000285: SECURITY DEFINER, reads the
-- admin-only settings.push_internal_secret, gated on settings.push_enabled, via
-- pg_net. The flagger (new.created_by) is dropped by send-push's actor filter,
-- so you don't get pinged about your own flag. Auto-flags have created_by NULL
-- (no actor to drop).
--
-- Recipients: project_flagged is a PROOF event in send-push, defaulted 'on'
-- (broad — every subscribed staffer) here, because the value of a flag alert is
-- precisely that non-designers (whoever picks up the phone) hear about it.
-- Tunable per-user on /settings/notifications.

create or replace function proofs.notify_push_on_project_flagged()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
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
      'event_code', 'project_flagged',
      'proof_id', new.proof_id,
      'source_kind', 'condition',
      'source_event_id', new.id::text,
      'actor_user_id', new.created_by,
      'vars', jsonb_build_object(
        'category', case new.category
          when 'lost_in_transit'   then 'Lost in transit'
          when 'reprint'           then 'Reprint'
          when 'quality_complaint' then 'Quality complaint'
          when 'delayed'           then 'Delayed'
          when 'payment_issue'     then 'Payment issue'
          else 'Flagged'
        end
      )
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_project_flagged() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_project_flagged() to service_role;

drop trigger if exists notify_push_on_project_flagged on proofs.watch_items;
create trigger notify_push_on_project_flagged
  after insert on proofs.watch_items
  for each row execute function proofs.notify_push_on_project_flagged();

-- Default the new event ON (broad) for both roles, and add its lock-screen copy.
-- jsonb_set create_missing defaults true, so the keys are added in place.
update proofs.settings
set notification_role_defaults = jsonb_set(
      jsonb_set(
        coalesce(notification_role_defaults, '{}'::jsonb),
        '{admin,project_flagged}', '"on"'),
      '{designer,project_flagged}', '"on"'),
    notification_copy = jsonb_set(
      coalesce(notification_copy, '{}'::jsonb),
      '{project_flagged}',
      '{"title": "Project flagged", "body": "{company} — {category}"}'::jsonb)
where id = 1;
