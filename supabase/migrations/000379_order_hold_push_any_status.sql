-- 000379 — notify the holder whatever status the held order was in.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- WHY. 000378's guard was `if new.status is distinct from 'paid' then return`,
-- written when holds could only be raised on a paid order. That is no longer
-- true: the "Put on hold…" menu item is now offered on REVISION orders too,
-- because a revision order becomes placeable again the moment the customer
-- approves the new version — while still being 'revision' — so a question
-- arising at that point needs the same block. Left as it was, a colleague
-- taking a hold off a revision order would notify nobody, silently.
--
-- THE RULE THE GUARD WAS ACTUALLY REACHING FOR. Its job is to tell a
-- DELIBERATE release apart from the AUTOMATIC clear, and only notify about the
-- first. The automatic clear (orders_hold_guard branch 2) fires only ever as a
-- side effect of the status changing away from 'paid' — so "the status did not
-- change" is the exact test, and it happens to be status-agnostic. Keying on
-- 'paid' was a proxy for it that only worked while holds were paid-only.
--
-- Everything else in the function is byte-for-byte 000378.

create or replace function proofs.notify_push_on_order_hold_released()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_secret  text;
  v_actor   text;
  v_company text;
begin
  if old.held_at is null or new.held_at is not null then
    return new;
  end if;

  -- A deliberate release, not the automatic clear. The clear only happens as a
  -- side effect of a status change (orders_hold_guard branch 2), so an
  -- unchanged status IS "somebody chose to do this" — and unlike the old
  -- `= 'paid'` test, it stays correct now holds are allowed on revision orders.
  if new.status is distinct from old.status then
    return new;
  end if;

  -- Nobody to address / you taking off your own hold.
  if old.held_by is null or old.held_by is not distinct from auth.uid() then
    return new;
  end if;

  select push_enabled, push_internal_secret
    into v_enabled, v_secret
  from proofs.settings where id = 1;

  if not coalesce(v_enabled, false) or v_secret is null then
    return new;
  end if;

  select full_name into v_actor from proofs.profiles where id = auth.uid();

  select coalesce(co.name, ct.full_name)
    into v_company
  from proofs.proofs p
  left join proofs.contacts ct on ct.id = p.contact_id
  left join proofs.companies co on co.id = ct.company_id
  where p.id = new.proof_id;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'event_code', 'order_hold_released',
      'order_id', new.id,
      'source_kind', 'order',
      -- One notification per HOLD, not per order: the outbox dedups on
      -- (event, source_kind, source_event_id, recipient), so a bare
      -- '<order id>:hold_released' would swallow every later hold on the same
      -- order. Stamping when the released hold was RAISED keys each one
      -- uniquely while keeping a retry idempotent.
      'source_event_id', new.id::text || ':hold_released:' ||
        extract(epoch from old.held_at)::bigint::text,
      'actor_user_id', auth.uid(),
      'recipient_user_ids', to_jsonb(array[old.held_by]),
      'vars', jsonb_build_object(
        'actor', coalesce(nullif(btrim(v_actor), ''), 'Someone'),
        'company', coalesce(nullif(btrim(v_company), ''), 'a customer')
      )
    )
  );
  return new;
end;
$$;

-- CREATE OR REPLACE keeps the 000378 grants and the trigger binding; restated
-- only because the proofs schema has no pg_default_acl for functions and a
-- future replace should not quietly widen them.
revoke execute on function proofs.notify_push_on_order_hold_released() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_order_hold_released() to service_role;
