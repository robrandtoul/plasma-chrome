-- 000367 — tell a customer looking at their proof that ordering happens
-- somewhere else, without handing them the pay link.
--
-- THE PROBLEM (live, 2026-07-30). A customer approved three cards, was sent
-- a combined pay link, and then went back to /p/:id and tried to buy from
-- the pricing table:
--
--   "how do I add the cards into my cart for ordering? I cant click on any
--    of the quantities? I also tried using the specific quantity box and i
--    can enter a number but still have nowhere to select add to order or
--    add to cart?"
--
-- Every clause is accurate. The proof page's price grid is display-only, the
-- "Need a price for a specific quantity?" box is a lookup, and there is no
-- order control anywhere on the page — it doesn't even know an order exists.
-- So the page reads as broken to anyone who has approved and wants to spend
-- money, and the only route back to the pay link is an email they may have
-- lost.
--
-- WHAT THIS RPC DOES NOT DO — and why. The obvious fix is to put the pay
-- link on the proof page. That is exactly what this repo has already
-- decided, in writing, not to do:
--
--   "deliberately NOT server-derived: exposing the bundle token through the
--    card's public payload would let anyone holding a single card's /p/ link
--    reach the whole bundle. Carried in the URL instead, the back link
--    exists only for visitors who came through the front door — who by
--    definition already hold the token — and every other visitor
--    (standalone customers, team-share recipients, old links) sees the page
--    unchanged."                          — src/lib/customerProofUrl.ts:26-34
--
-- /p/:id is deliberately broad: team sharing hands `?for=<name>` links to
-- colleagues, and docs/team-sharing-feature.md states outright that "the
-- links are a convenience, not security". The pay page is deliberately
-- narrow: a second bearer token, posted to the project contact on the Help
-- Scout thread. Publishing the token on the proof page would collapse those
-- two populations into one — everyone who can look at the artwork becomes
-- everyone who can transact.
--
-- And the transacting is not read-only. A pay-token holder can pay (an
-- irreversible money event that raises the Xero invoice and starts
-- production), set the delivery address/phone that the parcel ships to,
-- write the customs/EORI tax id onto the invoice, post free text into the
-- staff Help Scout queue via order-question — and, without paying anything,
-- silently rewrite the order's persisted quantity / thickness / finish,
-- because create-checkout-session stamps those onto the row at
-- PaymentIntent-creation time (create-checkout-session/index.ts:789-807).
-- Restricting the link to the UNPAID state would be backwards: every write
-- and the only irreversible money event live there.
--
-- So this returns a FACT, never a capability: is there a payment link
-- waiting, has it expired, or has this already been paid for. No order id,
-- no group id, no token, no amounts, no currency, no quantity, no spec, no
-- contact details. The page uses it to say "your payment link was emailed
-- to you" instead of looking broken; the link itself still only travels the
-- channel create-order sends it down.
--
-- A dedicated small RPC rather than extending public_get_customer_proof, per
-- the precedent set in 000347: that function is large, and every re-emit of
-- a customer-facing read path in this repo has at some point lost its grants
-- (000148→000151, 000168→000174, 000186→000197, 000268→000309). Same house
-- shape as public_get_lead_times (000180) and public_get_price_list (000184)
-- — tight surface, no fresh table grant to anon.

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
      -- ⚠ Payment resolves from EITHER side, and is deliberately NOT part of
      -- the group override above. A group can legitimately govern an unpaid
      -- member's dormant link, but no group state can make an already-paid
      -- order unpaid, so the member's own stamp must win when it has one.
      -- This is not hypothetical: order ORD-2E80161108 on live was paid
      -- 2026-07-13 through its own single-order link and fulfilled the next
      -- day, while the group a designer had just built around it stayed at
      -- status='sent'/paid_at=null (the customer was already mid-checkout
      -- when it was grouped — a race nothing prevents). Reading paid_at from
      -- the group alone reported that proof as 'link_expired', i.e. it would
      -- have invited a customer who had already paid AND received their
      -- cards to ask for a fresh payment link. Every healthy path is
      -- unchanged: stripe-webhook group mode stamps each member's own
      -- paid_at, so on all 7 paid groups live today both sides agree.
      coalesce(o.paid_at, og.paid_at) as eff_paid_at
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ),
  ranked as (
    select
      r.*,
      case
        -- Money first, and read from paid_at rather than the status text:
        -- 'paid' and 'fulfilled' both mean paid, and so does 'revision' (a
        -- paid order held for a design change). Keying on the timestamp
        -- means a future status never silently reads as "not ordered" and
        -- shows a paying customer a "Ready to order?" prompt.
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        -- draft / cancelled / expired / anything else: nothing to say.
        else null
      end as state
    from resolved r
  )
  select coalesce(
    (
      select jsonb_strip_nulls(jsonb_build_object(
        'state', state,
        -- Only for a live link, and only so the page can say "valid until
        -- <date>". The customer's own deadline; nothing derivable from it.
        'expires_at', case when state = 'awaiting_payment' then eff_expires_at end
      ))
      from ranked
      where state is not null
      -- 000340 allows at most one LIVE pay link per proof, but a proof can
      -- carry historic rows (a paid original beside a cancelled retry), so
      -- rank deterministically: a live link outranks a past payment, which
      -- outranks a dead link; ties break on the most recent date.
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
  'none) plus a live link''s expiry. ⚠ Never add the order id, group id or '
  'token: /p/:id is shared broadly (team sharing) while the pay link is '
  'deliberately narrow, and a pay-token holder can pay, redirect the '
  'parcel, and rewrite the order spec without paying. See 000367 header '
  'and src/lib/customerProofUrl.ts:26-34.';
