-- 000401: let a proof with no order say that a reorder has been requested.
--
-- The Reorder desk (000389) creates a BRAND NEW proof for a past customer we
-- approached. That proof has artwork and a customer link, but it has no row in
-- proofs.orders — the customer has not bought anything through it yet. The
-- welcome-back band on /p/:id is about to route into the existing reorder
-- REQUEST mechanism (000372/000373/000374), so the page must be able to read
-- back "you asked us for these on the 9th" and "your reorder is over here".
--
-- Today it cannot. Both keys are built INSIDE this:
--
--     coalesce( (select ... from projected p cross join lateral (...) pr),
--               jsonb_build_object('state', 'none') )
--
-- `projected` is fed from `winner` <- `ranked` <- `resolved`, and `resolved`
-- selects `from proofs.orders o where o.proof_id = p_proof_id`. With no order
-- row that chain yields NO ROWS, the scalar sub-select is NULL, the coalesce
-- fires, and the ENTIRE object collapses to {"state":"none"} — taking
-- 'reorder_requested_at' and 'reorder_proof_id' with it. They are properties of
-- the PROOF, not of an order, so they were never order-shaped; they were only
-- ever written inside the order-shaped branch because until now every proof
-- that could carry them happened to have an order.
--
-- 000392 hit exactly this and hoisted one key ('reengagement') outside the
-- coalesce with a trailing `|| jsonb_strip_nulls(jsonb_build_object(...))`.
-- This extends that same append rather than inventing a second mechanism.
--
-- ⚠ 'reorder_available' is deliberately NOT hoisted. It is genuinely
-- order-derived — it reads p.state = 'paid' and p.quiet_passed, i.e. a paid
-- order that has been delivered (or dispatched) long enough ago for the quiet
-- window to have passed. On a proof with no orders there is nothing to reorder
-- yet, so the honest answer is absent/false and the key must stay inside the
-- projection. Hoisting it would make an outreach proof advertise a repeat of a
-- purchase it never carried.
--
-- Two structural notes, both load-bearing:
--
-- 1. The keys are appended by `||`, and in a jsonb merge the RIGHT side wins.
--    On an order-BEARING proof both sides read the same proofs.proofs row in
--    the same STABLE snapshot, so the merge is a no-op — proved below.
-- 2. `jsonb || NULL` is NULL, which would turn the whole RPC into a SQL NULL
--    for an unknown proof id. That is why each key is its own scalar subquery
--    inside jsonb_build_object (which always returns a real object) rather than
--    one subquery returning the whole object. Verified: an unknown id still
--    returns {"state":"none"}, not NULL.
--
-- 'reorder_proof_id' has no column behind it — it is the derived "did a
-- designer actually raise the reorder?" child lookup, lifted verbatim from the
-- lateral above (token-identical, only its indentation depth differs).
--
-- Verified read-only against live before applying, at proofs.public_get_proof_order_state:
--   * this exact body, inlined per proof, vs the live function over EVERY proof
--     (508 at the time of writing) -> 508 identical, 0 differing, 0 NULL, and
--     an unknown proof id still returns {"state":"none"}. (Vacuous on its own: live
--     currently has 0 rows with reorder_requested_at and 0 reorder children, so
--     both new keys are null and jsonb_strip_nulls removes them — which is the
--     point: ordinary proofs stay byte-identical.)
--   * with synthetic non-null values injected identically into BOTH shapes:
--     an order-less outreach proof goes {"state":"none"} -> carries both keys;
--     an order-bearing paid proof is byte-identical before and after (the merge
--     agrees), and 'reorder_available' remains present there and ABSENT on the
--     order-less proofs.
--
-- CREATE OR REPLACE, signature unchanged, so the ACL survives — this RPC is
-- EXECUTE-granted to anon (it is what /p/:id reads) as well as authenticated.
-- Body re-emitted from the LIVE pg_get_functiondef (which carries 000375's
-- shipped_at and 000392's reengagement append), never rebuilt from an older
-- migration file.

create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at,
      o.stock_order_number,
      o.status as own_status
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ),
  ranked as (
    select
      r.*,
      case
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        else null
      end as state
    from resolved r
  ),
  winner as (
    select *
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
  projected as (
    select
      w.*,
      case when w.state = 'paid'
           then proofs._project_order_tracking(w.stock_order_number, p_proof_id, w.own_status)
      end as proj,
      case when w.state = 'paid'
           then proofs._reorder_quiet_period_passed(w.stock_order_number)
           else false end as quiet_passed
    from winner w
  )
  select
    coalesce(
      (
        select jsonb_strip_nulls(jsonb_build_object(
          'state', p.state,
          'expires_at', case when p.state = 'awaiting_payment' then p.eff_expires_at end,
          'resend_requested_at', case when p.state = 'awaiting_payment' then p.eff_resend_at end,
          -- ⚠ Three keys only, hand-picked. Never `|| p.proj`.
          'stage',
            case when p.proj ->> 'level' in ('broad', 'granular')
                 then p.proj ->> 'stage' end,
          'delivery_tracked',
            case when p.proj ->> 'level' in ('broad', 'granular')
                 then (p.proj ->> 'delivery_tracked')::boolean end,
          -- 000375. A date, not a handle: it makes "shipped on the 12th" sayable
          -- and cannot be used to touch the parcel.
          'shipped_at',
            case when p.proj ->> 'level' in ('broad', 'granular')
                 then p.proj ->> 'shipped_at' end,
          -- ⚠ 000401. This one STAYS here. It is order-derived (paid + quiet
          -- window passed), so on an order-less proof its honest value is
          -- absent. Do not move it into the append below.
          'reorder_available',
            (select reorder_enabled from proofs.settings where id = 1)
              and p.state = 'paid'
              and p.quiet_passed
              and pr.status = 'approved',
          -- 000401. These two are still emitted here so an order-bearing proof
          -- is unchanged; the append below re-states them for the no-order
          -- case. Both read the same proofs.proofs row, so the merge agrees.
          'reorder_requested_at', pr.reorder_requested_at,
          'reorder_proof_id', pr.reorder_proof_id
        ))
        from projected p
        cross join lateral (
          select
            pp.status,
            pp.reorder_requested_at,
            (
              select child.id
              from proofs.proofs child
              join proofs.proof_versions cpv
                on cpv.proof_id = child.id and cpv.is_current
              where child.reorder_of_proof_id = p_proof_id
                and child.status <> 'abandoned'
                and (child.status = 'approved' or cpv.last_reply_sent_at is not null)
              order by child.created_at desc
              limit 1
            ) as reorder_proof_id
          from proofs.proofs pp
          where pp.id = p_proof_id
        ) pr
      ),
      jsonb_build_object('state', 'none')
    )
    -- 000392: one named key, appended outside the order-shaped result above so
    -- it survives the no-order case. Absent (not null) on ordinary proofs.
    -- 000401: two more join it. They are facts about the PROOF, not the order,
    -- and an outreach proof (Reorder desk, no orders row) has to be able to
    -- report them. Each is its own scalar subquery so jsonb_build_object always
    -- returns a real object — `jsonb || NULL` would be NULL and would take the
    -- whole reply with it. 'reorder_available' is NOT here: see above.
    || jsonb_strip_nulls(jsonb_build_object(
         'reengagement',
         (select pp.reengagement_context from proofs.proofs pp where pp.id = p_proof_id),
         'reorder_requested_at',
         (select pp.reorder_requested_at from proofs.proofs pp where pp.id = p_proof_id),
         -- Lifted verbatim from the lateral above: "has a designer actually
         -- raised the reorder, and is it named-able yet?" (approved, or sent).
         'reorder_proof_id',
         (
           select child.id
           from proofs.proofs child
           join proofs.proof_versions cpv
             on cpv.proof_id = child.id and cpv.is_current
           where child.reorder_of_proof_id = p_proof_id
             and child.status <> 'abandoned'
             and (child.status = 'approved' or cpv.last_reply_sent_at is not null)
           order by child.created_at desc
           limit 1
         )
       ));
$function$;
