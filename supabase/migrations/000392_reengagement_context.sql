-- 000392: tell the customer page when a proof is re-engagement outreach, so it
-- can greet a past customer we approached rather than interrogating them like
-- someone who commissioned new work.
--
-- The Reorder desk (000389) reaches customers who did NOT ask for a proof. The
-- customer page's whole grammar assumes the opposite — it opens by asking for
-- approval of work the customer has been waiting for. For a past customer
-- looking at their OWN card, re-presented, the honest first questions are
-- "do you remember us, are these details still right, and do you want more?".
-- The page can only ask them if it knows; today it cannot.
--
-- 1. proofs.reengagement_context — the display-safe snapshot.
--
-- ⚠ CUSTOMER-VISIBLE BY CONSTRUCTION. This column is returned verbatim to an
-- anonymous caller by the RPC below, so ONLY display-safe fields may ever be
-- written to it. The register it is derived from (proofs.reorder_prospects)
-- holds lifetime value, scores and internal notes, NONE of which may appear
-- here. Same discipline as orders.previous_spec (000364), and the write side
-- enforces an allow-list (src/lib/reengagement.ts buildReengagementContext).
--
-- Shape: { "last_order_on": "2024-03-18", "orders_count": 4 }
-- Both optional; the object's mere presence is the "this is outreach" flag.

alter table proofs.proofs
  add column reengagement_context jsonb;

-- Structural backstop for the allow-list. The application builds this object
-- field-by-field (never a spread of the register row), but the column is
-- written by an ordinary authenticated session and published verbatim to anon,
-- so the invariant is worth enforcing where it cannot be forgotten. Subtracting
-- the two permitted keys must leave an empty object; anything else — a score, a
-- value, a note, a typo'd key — fails the insert instead of reaching a customer.
-- (Same belt-and-braces stance as 000173's CHECK behind the form-side gates.)
alter table proofs.proofs
  add constraint proofs_reengagement_context_keys_chk
  check (
    reengagement_context is null
    or (
      jsonb_typeof(reengagement_context) = 'object'
      and (reengagement_context - 'last_order_on' - 'orders_count') = '{}'::jsonb
    )
  )
  not valid;

alter table proofs.proofs
  validate constraint proofs_reengagement_context_keys_chk;

comment on column proofs.proofs.reengagement_context is
  'Display-safe snapshot for the re-engagement band on /p/:id (000392). Returned '
  'VERBATIM to anon via public_get_proof_order_state — never write anything here '
  'that a customer must not read (no scores, no lifetime value, no internal notes). '
  'Presence of the object is itself the "outreach proof" flag.';

-- 2. Expose it on the customer page's small companion RPC.
--
-- Deliberately NOT public_get_customer_proof: that function is 10KB of
-- hand-maintained payload with a long history of re-emit drift, and this needs
-- one nullable key. public_get_proof_order_state is already the home for
-- "extra state about this proof", is already granted to anon, and is already
-- called by the page.
--
-- ⚠ The body below is the LIVE definition (read via pg_get_functiondef on
-- 2026-08-09) BYTE-FOR-BYTE, with exactly one change: the whole existing
-- result is wrapped so a single named key can be appended. That wrap is
-- structural, not cosmetic — the existing body's `coalesce(<select>, '{"state":
-- "none"}')` only yields rows when an ORDER exists, and an outreach proof has
-- none, so a key added INSIDE the object would never reach the customer it was
-- built for.
--
-- This does not breach the 000371 rule stamped above ("Three keys only, hand-
-- picked. Never `|| p.proj`"). That rule forbids spreading the internal order
-- projection, which leaks granular delivery data. This appends one named
-- column the customer is entitled to see, from a different source, and
-- jsonb_strip_nulls means non-outreach proofs get byte-identical output.

create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable security definer
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
          'reorder_available',
            (select reorder_enabled from proofs.settings where id = 1)
              and p.state = 'paid'
              and p.quiet_passed
              and pr.status = 'approved',
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
    || jsonb_strip_nulls(jsonb_build_object(
         'reengagement',
         (select pp.reengagement_context from proofs.proofs pp where pp.id = p_proof_id)
       ));
$function$;
