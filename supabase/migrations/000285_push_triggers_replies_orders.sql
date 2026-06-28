-- 000285: more push-notification triggers — email replies + order events.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- Extends the trigger-based wiring from 000284 (which never touches the live
-- edge functions). Three more AFTER triggers, each gated on settings.push_enabled
-- and calling send-push via pg_net with settings.push_internal_secret:
--
--   * proofs  AFTER UPDATE OF helpscout_last_customer_reply_at (newer value)
--       -> 'customer_replies_by_email'   (a customer replied on the HS thread;
--          the helpscout-webhook stamps this column, 000208)
--   * orders  AFTER UPDATE OF status, status newly 'paid'
--       -> 'order_paid'                  (this is the "to order" signal for the
--          fulfilment list — there's no distinct to-order status; paid = fulfil)
--   * orders  AFTER UPDATE OF pay_link_opened_at (null -> set)
--       -> 'pay_link_opened'             (000262 setter; the 000266 staff guard
--          means only a genuine customer open stamps it)
--
-- Order events resolve recipients from settings.fulfilment_user_ids (Rob + Chris)
-- and are additionally gated inside send-push behind payment_mode='live'.
-- The reply event is a proof-level event, so it follows the role default
-- (designers hear their OWN projects' replies) plus Rob's firehose.

begin;

-- ── Trigger 3: customer replied by email ─────────────────────────────────────
create or replace function proofs.notify_push_on_customer_reply()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
  -- Only on a genuinely newer reply timestamp (so a backfill that writes an
  -- older/equal value can't fire a burst of pushes).
  if new.helpscout_last_customer_reply_at is null
     or new.helpscout_last_customer_reply_at
        <= coalesce(old.helpscout_last_customer_reply_at, '-infinity'::timestamptz) then
    return new;
  end if;

  select push_enabled, push_internal_secret into v_enabled, v_secret
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
      'event_code', 'customer_replies_by_email',
      'proof_id', new.id,
      'source_kind', 'condition',
      'source_event_id', new.id::text || ':reply:' ||
        extract(epoch from new.helpscout_last_customer_reply_at)::bigint::text
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_customer_reply() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_customer_reply() to service_role;

drop trigger if exists notify_push_on_customer_reply on proofs.proofs;
create trigger notify_push_on_customer_reply
  after update of helpscout_last_customer_reply_at on proofs.proofs
  for each row execute function proofs.notify_push_on_customer_reply();

-- ── Trigger 4: order paid ("to order" for the fulfilment list) ───────────────
create or replace function proofs.notify_push_on_order_paid()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
  if new.status <> 'paid' or old.status is not distinct from 'paid' then
    return new;
  end if;

  select push_enabled, push_internal_secret into v_enabled, v_secret
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
      'event_code', 'order_paid',
      'order_id', new.id,
      'source_kind', 'order',
      'source_event_id', new.id::text || ':paid'
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_order_paid() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_order_paid() to service_role;

drop trigger if exists notify_push_on_order_paid on proofs.orders;
create trigger notify_push_on_order_paid
  after update of status on proofs.orders
  for each row execute function proofs.notify_push_on_order_paid();

-- ── Trigger 5: pay link opened ───────────────────────────────────────────────
create or replace function proofs.notify_push_on_pay_link_opened()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
begin
  if old.pay_link_opened_at is not null or new.pay_link_opened_at is null then
    return new;  -- only the first genuine open (000266 guards staff opens out)
  end if;

  select push_enabled, push_internal_secret into v_enabled, v_secret
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
      'event_code', 'pay_link_opened',
      'order_id', new.id,
      'source_kind', 'order',
      'source_event_id', new.id::text || ':opened'
    )
  );
  return new;
end;
$$;

revoke execute on function proofs.notify_push_on_pay_link_opened() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_pay_link_opened() to service_role;

drop trigger if exists notify_push_on_pay_link_opened on proofs.orders;
create trigger notify_push_on_pay_link_opened
  after update of pay_link_opened_at on proofs.orders
  for each row execute function proofs.notify_push_on_pay_link_opened();

commit;
