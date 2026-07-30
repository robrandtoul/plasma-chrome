-- 000369 — let a customer ask for their payment link again, from the proof page.
--
-- 000367 gave the proof page a "Ready to order?" card that says ordering
-- happens through an emailed link and "just reply to any message from us".
-- That ends the dead end but still puts a human in the loop for the commonest
-- failure there is: the email is buried, filtered, or was never actually sent
-- (status 'sent' means the link is LIVE, not delivered — create-order posts
-- nothing to Help Scout, and a combined-payment group has no send step at
-- all). This adds the button that closes the loop.
--
-- ⚠ THE LINK STILL NEVER TOUCHES THE PROOF PAGE. The button triggers a
-- server-side re-post onto the proof's linked Help Scout conversation — the
-- same channel a designer sends down — and the edge function returns
-- {status:'ok'} and nothing else. The URL is never in the response, and the
-- recipient is never a request parameter, so a /p/ link holder (team sharing
-- hands those out freely) can cause a message to reach the real customer but
-- can never receive the link themselves. Making the address structurally
-- absent is the point; validating one would not be equivalent.
--
-- Three parts:
--
-- 1. The cooldown stamp, one nullable column per payable thing. Both tables
--    need it because 000367 already established that a group governs its
--    members: a grouped member's own link is dormant and OrderPayPage refuses
--    its token while the group is live, so a resend must target whichever of
--    the two is actually payable. Columns inherit the tables' grants, so
--    there is no grant work here (anon holds nothing on either table — the
--    write goes through the service-role edge function).
--
--    Deliberately NOT reusing an existing column: help_requested_at drives
--    the Orders-page "Asked for help" chip and would file a resend as an
--    unanswered customer question, and pay_link_opened_at is the "has the
--    customer seen it" signal 000368 was just written to stop corrupting.
--
-- 2. A seeded, admin-editable reply template, per the house pattern
--    (000157 / 000207 / 000311). Body mirrors DEFAULT_BODIES in
--    src/lib/replyTemplates.ts so the admin "Reset to default" works.
--
-- 3. public_get_proof_order_state re-emitted to carry the resend stamp, so a
--    customer who clicks and then reloads sees "we've just sent that" rather
--    than a re-armed button. Still a FACT, never a capability — a timestamp
--    of their own action, no id and no token. Re-emitted from the live 000367
--    body with grants re-stated, per the house rule.

-- ── 1. Cooldown stamps ───────────────────────────────────────────────────
alter table proofs.orders
  add column if not exists pay_link_resend_requested_at timestamptz;

alter table proofs.order_groups
  add column if not exists pay_link_resend_requested_at timestamptz;

comment on column proofs.orders.pay_link_resend_requested_at is
  'When the customer last asked for this pay link to be re-sent from the '
  'proof page (000369). Written by the resend-pay-link edge function as an '
  'atomic claim — the cooldown lives in that UPDATE''s WHERE clause — and '
  'deliberately never cleared, so a failed send cannot become a retry loop '
  'into the customer''s thread.';

comment on column proofs.order_groups.pay_link_resend_requested_at is
  'Combined-payment twin of proofs.orders.pay_link_resend_requested_at '
  '(000369). A grouped member pays through the group link, so the group is '
  'what a resend targets and what the cooldown is held against.';

-- ── 1b. Resolve-and-claim, atomically, in one statement ──────────────────
-- The rate limiter is the only thing between a widely-shared /p/ URL and a
-- customer's inbox, so it does not rest on a filter string assembled in
-- TypeScript. This does the whole thing in SQL: resolve which of the order or
-- its group is actually payable, then claim the cooldown in the WHERE clause
-- of the UPDATE that stamps it. Postgres serialises concurrent UPDATEs on the
-- row, so a second caller re-evaluates against the updated row and matches
-- nothing — exactly one wins, with no read-then-write race (the 000346
-- pattern).
--
-- ⚠ This returns a pay-link TOKEN, so it is service_role ONLY. The revoke is
-- load-bearing: the proofs schema has no pg_default_acl entry for functions,
-- so a new function defaults to EXECUTE TO PUBLIC, anon holds schema USAGE,
-- and PostgREST would serve it straight to the internet (the 000356 lesson).
create or replace function proofs.claim_pay_link_resend(
  p_proof_id         uuid,
  p_cooldown_minutes int default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_tbl        text;
  v_id         uuid;
  v_token      text;
  v_claimed    uuid;
  v_conv       text;
  v_first_name text;
begin
  -- Which of the two is payable? Same resolution rule as
  -- public_get_proof_order_state: a grouped member's own link is dormant
  -- while its group is live, so the group is what a resend must target; a
  -- cancelled group releases its members back to their own links.
  select tbl, id, token into v_tbl, v_id, v_token
  from (
    select
      case when og.id is not null and og.status <> 'cancelled' then 'g' else 'o' end as tbl,
      case when og.id is not null and og.status <> 'cancelled' then og.id else o.id end as id,
      case when og.id is not null and og.status <> 'cancelled' then og.token else o.token end as token,
      case when og.id is not null and og.status <> 'cancelled' then og.status else o.status end as status,
      coalesce(o.paid_at, og.paid_at) as paid_at,
      case when og.id is not null and og.status <> 'cancelled' then og.expires_at else o.expires_at end as expires_at
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ) r
  where r.paid_at is null
    and r.status = 'sent'
    and (r.expires_at is null or r.expires_at > now())
    and r.token is not null
  limit 1;

  if v_id is null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The destination is the proof's own conversation, never a caller input.
  select p.helpscout_conversation_id::text,
         split_part(btrim(coalesce(c.full_name, '')), ' ', 1)
    into v_conv, v_first_name
  from proofs.proofs p
  left join proofs.contacts c on c.id = p.contact_id
  where p.id = p_proof_id;

  if v_conv is null or v_conv = '' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The claim.
  if v_tbl = 'g' then
    update proofs.order_groups
       set pay_link_resend_requested_at = now()
     where id = v_id
       and (pay_link_resend_requested_at is null
            or pay_link_resend_requested_at < now() - make_interval(mins => p_cooldown_minutes))
    returning id into v_claimed;
  else
    update proofs.orders
       set pay_link_resend_requested_at = now()
     where id = v_id
       and (pay_link_resend_requested_at is null
            or pay_link_resend_requested_at < now() - make_interval(mins => p_cooldown_minutes))
    returning id into v_claimed;
  end if;

  if v_claimed is null then
    -- Inside the cooldown. The caller reports this to the customer exactly as
    -- a success: they already got what they asked for, and an identical
    -- response shape keeps the endpoint from being used to probe.
    return jsonb_build_object('outcome', 'throttled');
  end if;

  return jsonb_build_object(
    'outcome',         'claimed',
    'target',          case when v_tbl = 'g' then 'group' else 'order' end,
    'target_id',       v_id,
    'token',           v_token,
    'conversation_id', v_conv,
    'first_name',      coalesce(v_first_name, '')
  );
end;
$function$;

revoke all on function proofs.claim_pay_link_resend(uuid, int) from public, anon, authenticated;
grant execute on function proofs.claim_pay_link_resend(uuid, int) to service_role;

comment on function proofs.claim_pay_link_resend(uuid, int) is
  'Resolves the payable order/group for a proof and atomically claims the '
  'resend cooldown, returning the pay token for the resend-pay-link edge '
  'function to compose with. ⚠ SERVICE ROLE ONLY — it returns a pay-link '
  'bearer token. The revoke from public/anon/authenticated is load-bearing: '
  'the proofs schema has no default function ACL, so this would otherwise be '
  'callable from the internet via PostgREST (000356). Never grant it wider.';

-- ── 2. The message the customer receives ─────────────────────────────────
insert into proofs.reply_templates (id, display_name, description, body)
values (
  'order_link_resend',
  'Payment link re-sent',
  'Sent automatically when a customer asks for their payment link again from the "Ready to order?" card on their proof page. {order_url} is the live pay link — for a combined payment it is the one link covering every card.',
  E'Hi{? first_name} {first_name}{/?},\n\nNo problem — here''s the link to order your cards again. You can choose your quantity, confirm delivery, and pay securely here:\n\n{order_url}\n\nIf it keeps not arriving, just reply to this email and we''ll sort it out another way.'
)
on conflict (id) do nothing;

-- ── 3. Expose the stamp on the customer read path ────────────────────────
-- Body is 000367's verbatim, plus resend_requested_at in the projection.
create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      -- A grouped member pays through its GROUP's link: its own row stays
      -- 'sent' with a dormant link and a frozen expiry, and OrderPayPage
      -- refuses its own token while the group is live. So the group governs
      -- both the status and the deadline. A cancelled group releases its
      -- members back to their own links (order-lifecycle), which is why
      -- that one state falls through to the order's own columns.
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      -- ⚠ Payment resolves from EITHER side (see 000367): no group state can
      -- make an already-paid order unpaid, so the member's own stamp wins.
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      -- Same resolution rule as the status/deadline above: the resend is
      -- held against whichever row is actually payable.
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ),
  ranked as (
    select
      r.*,
      case
        -- Money first, read from paid_at rather than the status text.
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        else null
      end as state
    from resolved r
  )
  select coalesce(
    (
      select jsonb_strip_nulls(jsonb_build_object(
        'state', state,
        'expires_at', case when state = 'awaiting_payment' then eff_expires_at end,
        -- Only where a resend is offered. The customer's own click, echoed
        -- back so a reload shows the acknowledgement instead of re-arming
        -- the button. No id, no token — the 000367 rule stands.
        'resend_requested_at', case when state = 'awaiting_payment' then eff_resend_at end
      ))
      from ranked
      where state is not null
      order by case state
                 when 'awaiting_payment' then 1
                 when 'paid'             then 2
                 when 'link_expired'     then 3
               end,
               coalesce(eff_paid_at, eff_expires_at) desc nulls last
      limit 1
    ),
    jsonb_build_object('state', 'none')
  );
$function$;

revoke all on function proofs.public_get_proof_order_state(uuid) from public;
grant execute on function proofs.public_get_proof_order_state(uuid) to anon, authenticated;

comment on function proofs.public_get_proof_order_state(uuid) is
  'Customer proof page: is there a payment link waiting for this proof? '
  'Returns a FACT ONLY — state (awaiting_payment | link_expired | paid | '
  'none), a live link''s expiry, and the customer''s own last resend '
  'request. ⚠ Never add the order id, group id or token: /p/:id is shared '
  'broadly (team sharing) while the pay link is deliberately narrow, and a '
  'pay-token holder can pay, redirect the parcel, and rewrite the order '
  'spec without paying. See 000367/000369 and customerProofUrl.ts:26-34.';
