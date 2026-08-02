-- 000378 — tell the person who put an order on hold when someone else takes it off.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — not yet applied.
--
-- ⚠ DEPLOY ORDER: deploy `send-push` FIRST, then apply this migration.
-- Applying first would fire the trigger against a send-push that doesn't know
-- `order_hold_released` is an explicit-recipient event. It would fall through
-- to resolveContext, which resolves a proof id from the order and populates the
-- ownership machinery — so the notification would go to the proof's owner
-- instead of the person who put the hold on, which is both wrong and a small
-- leak of who is querying what. The function is inert on an unmigrated database
-- (the trigger simply doesn't exist yet), so function-first is safe in a way
-- migration-first is not.
--
-- THE GAP. 000377 lets anyone take a hold off, on purpose: the person who
-- raised the query may be off that day, and a hold nobody can clear is worse
-- than no hold at all. But the flip side is that the one person who most needs
-- to know it happened — whoever put it on, and is still sitting waiting for the
-- customer's answer — currently finds out by chance, if they happen to reopen
-- the Orders page. Their protection is gone and the order is placeable again.
-- That is exactly what a push is for: a rare, addressed-to-you fact you cannot
-- discover any other way.
--
-- SHAPE. Same idiom as the chat pushes (000320 mention / 000324 DM): an AFTER
-- trigger firing send-push through pg_net, gated on settings.push_enabled,
-- authenticating with settings.push_internal_secret, with the recipient named
-- EXPLICITLY rather than derived from who owns the project. Ownership is the
-- wrong question here — the holder is often not the designer whose proof it is.
--
-- WHAT IT DELIBERATELY DOES NOT FIRE ON:
--
--   * You taking your own hold off. Nobody needs telling what they just did.
--
--   * The AUTOMATIC clear. 000377 branch (2) nulls held_at whenever the order
--     leaves 'paid' — the customer confirmed the artwork was wrong, the order
--     moved to revision, and the hold's question has been overtaken. That is
--     the workflow moving on, not a colleague overriding a block, and the order
--     is left in a status that cannot be placed anyway. The guard below is
--     `new.status = 'paid'`, which excludes every one of those in one test AND
--     keeps the copy honest: "it can be placed now" is only ever sent about an
--     order that genuinely can be.
--
--     (Consequence worth knowing: a hold raised on an order that is NOT paid —
--     which the UI never offers, but the CHECK permits — would release silently.
--     Under-notifying a shape that should not exist is the safe direction.)
--
--   * A hold with no recorded holder (held_by is null, i.e. it was raised by a
--     service-role caller with no auth.uid()). There is nobody to address.

begin;

-- ── 1. The copy ────────────────────────────────────────────────────────────
-- Merge-in, and only when absent, so a replay never overwrites copy an admin
-- has since edited (the 000320 / 000324 pattern).
--
-- Title carries the fact, body carries who + which order + what it means. Both
-- are clipped by send-push (30 / 120 chars) — the title is 23 and never clips;
-- a very long company name costs the closing sentence, not the point.
--
-- {actor}   — who took it off ('Someone' if a hand-run release had no session)
-- {company} — the customer the order is for
update proofs.settings
  set notification_copy = coalesce(notification_copy, '{}'::jsonb) || jsonb_build_object(
    'order_hold_released',
    jsonb_build_object(
      'title', 'Your hold was taken off',
      'body',  '{actor} took it off the order for {company} — it is no longer held.'
    )
  )
  where id = 1
    and not (coalesce(notification_copy, '{}'::jsonb) ? 'order_hold_released');

-- ── 2. The trigger ─────────────────────────────────────────────────────────
-- SECURITY DEFINER: it reads the admin-only settings secret, and it reads
-- proofs.profiles for the actor's name — profiles SELECT is self-or-admin, so
-- an invoker-rights function would render nothing for most releases. Same
-- reasoning (and same lookup) as orders_hold_guard() in 000377.
--
-- No source_kind widening needed: 'order' has been allowed on
-- notification_outbox since 000283.
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
  -- Belt and braces: the trigger's WHEN clause already screens for this, but
  -- the function must be correct on its own if it is ever re-attached without.
  if old.held_at is null or new.held_at is not null then
    return new;
  end if;

  -- Deliberate release only, and only while the order is still placeable —
  -- see the header note on the automatic clear.
  if new.status is distinct from 'paid' then
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
    return new;  -- kill switch off → stay inert
  end if;

  -- Who took it off. Null when the release ran as service role (a hand-run SQL
  -- fix), which is a real case rather than an error — say 'Someone' instead of
  -- naming a person we do not have.
  select full_name into v_actor from proofs.profiles where id = auth.uid();

  -- Which order, in the words the team uses for it: the company, else the
  -- contact, else a neutral phrase. Left joins throughout so a proof with no
  -- contact (or a contact with no company) still produces a sentence.
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
      -- One notification per HOLD, not per order. The outbox dedups on
      -- (event, source_kind, source_event_id, recipient), so a bare
      -- '<order id>:hold_released' would silently swallow the second and every
      -- later hold on the same order. Stamping the moment the released hold was
      -- RAISED gives each hold its own key while keeping a retry idempotent.
      'source_event_id', new.id::text || ':hold_released:' ||
        extract(epoch from old.held_at)::bigint::text,
      'actor_user_id', auth.uid(),
      -- Explicitly the person who put it on. Not proof ownership.
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

-- The proofs schema has no pg_default_acl for functions, so a new function is
-- born EXECUTE TO PUBLIC. Triggers fire regardless of EXECUTE (the 000182 rule).
revoke execute on function proofs.notify_push_on_order_hold_released() from public, anon, authenticated;
grant execute on function proofs.notify_push_on_order_hold_released() to service_role;

-- AFTER UPDATE, so it can never interfere with the BEFORE guard 000377 installs
-- (orders_hold_guard normalises the release first — which is why every field
-- this reads comes from OLD: by now NEW.hold_reason, NEW.held_by and
-- NEW.held_by_name have all been nulled).
--
-- ⚠ No `of held_at` column list, on purpose. A column list fires only when the
-- column is NAMED IN the UPDATE statement, and the automatic clear sets held_at
-- from inside the BEFORE trigger while the statement itself names only `status`
-- — so `of held_at` would quietly skip that path, and a future decision to
-- notify on it would look wired up while doing nothing. The WHEN clause below
-- does the same executor-level filtering honestly: it is evaluated against the
-- final NEW row, after BEFORE triggers have had their say.
drop trigger if exists notify_push_on_order_hold_released on proofs.orders;
create trigger notify_push_on_order_hold_released
  after update on proofs.orders
  for each row
  when (old.held_at is not null and new.held_at is null)
  execute function proofs.notify_push_on_order_hold_released();

commit;
