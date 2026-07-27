-- 000356: stop Admin → Shipping chasing delivery details for parcels that have
-- already gone out.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- WHY: Admin → Shipping is a readiness worklist — post-payment orders still
-- missing the address / phone / destination / card weight a parcel needs. It
-- had no idea whether the parcel had since shipped, so it kept flagging orders
-- long after they were delivered. On live at authoring time it listed 60
-- orders, of which 49 had already gone to the customer and 17 were already
-- delivered; ALL 49 were flagged "No phone number" — the one detail that can no
-- longer possibly matter. The real worklist was 11. A worklist that is 82%
-- noise stops being read.
--
-- Stock Control records the dispatch, in the same database, and
-- proofs.orders.stock_order_number already links the two. This adds the read
-- path the tab was missing. Nothing is written; nothing else changes.
--
-- ── Why a SECURITY DEFINER function rather than a client-side join ──────
--
-- Stock Control's tables are RLS-gated on public.auth_role(), which resolves a
-- STOCK role from public.profiles. public.outsourced_orders is readable only by
-- stock support/admin/graphics — it carries the supplier supply chain, which
-- workshop staff are deliberately not shown. A proof-viewer admin who has no
-- Stock Control account resolves to NULL and reads nothing, so a direct browser
-- query would silently return "not shipped" for every outsourced order and the
-- tab would quietly go back to listing all 60. Silent wrong answers are the bad
-- kind, so the read runs as a definer function owned by postgres, exactly like
-- proofs.admin_search_orders (000263), which already joins these same two
-- tables for the Order log. Gated the same two ways: an explicit admin check on
-- auth.uid() in the body, and EXECUTE revoked from anon/public.
--
-- The function takes NO Stock Control identifier and joins OUTWARD from
-- proofs.orders. That is deliberate: ~57% of Stock's outsourced jobs never came
-- from proof-viewer, and a parameter naming a stock ref would let a caller
-- enumerate them. It returns dispatch timestamps only — no supplier, no
-- tracking number, no deadline, no notes.
--
-- ── What counts as "gone to the customer" ───────────────────────────────
--
-- One order can have several Stock Control legs: outsourced jobs split across
-- supplier batches (6 such groups on live), and the hybrid route where a
-- supplier makes the blanks and we foil them in-house, which produces one leg
-- in EACH table (7 on live). So the rule is ALL non-cancelled legs are done,
-- not any:
--
--   * "any leg" would be wrong. Live ref 403790 has 100 cards shipped and a
--     14-card top-up still sitting at the supplier.
--   * A cancelled leg is EXCLUDED, not counted as done. Live ref 403912 has a
--     cancelled in-house leg and an outsourced leg still in production — that
--     order genuinely still needs attention.
--   * An order with NO legs (not placed into Stock Control yet, or no
--     stock_order_number) can never be suppressed — it simply produces no row.
--
-- Per leg, done is status OR timestamp. In-house: 64 live rows are status
-- 'completed' with customer_shipped_at NULL (the shipping module went live in
-- July and older rows were never backfilled), so the status has to count on its
-- own. Outsourced is currently exact (status 'shipped_to_customer' ⟺
-- shipped_to_customer_at set, 129/129), but it is read the same way for
-- symmetry. customer_delivered_at also counts as shipped — there are no
-- delivered-but-not-shipped rows today, but both tables sync from a carrier and
-- that write ordering is possible in principle.
--
-- ⚠ NEVER count arrived_at or shipped_from_supplier_at. Those are the INBOUND
-- supplier → Plasma leg of an outsourced job (memory: the two-leg model).
-- "Arrived" means arrived at us, with the customer still waiting: two of the
-- live orders that correctly stay on the worklist are in exactly that state.
-- Likewise to_ship_at (queued, not gone), produced_at (made, not packed) and
-- the FedEx/DPD paperwork stamps (label printed, not collected).

create or replace function proofs.admin_order_shipping_state()
returns table (
  order_id     uuid,
  shipped_at   timestamptz,
  delivered_at timestamptz
)
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
begin
  -- Admin only (the page is RequireAdmin; enforce server-side too). Inlined
  -- rather than calling proofs.is_admin(), which does not check deactivated_at.
  if not exists (
    select 1 from proofs.profiles
    where id = auth.uid() and role = 'admin' and deactivated_at is null
  ) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  return query
  with covered as (
    -- The same post-payment population the Shipping tab lists. An order with no
    -- stock_order_number has not reached Stock Control, so it has no legs and
    -- can never be reported as shipped.
    select o.id, o.stock_order_number
    from proofs.orders o
    where o.status in ('paid', 'revision', 'fulfilled')
      and o.stock_order_number is not null
  ),
  legs as (
    -- In-house production.
    select
      c.id as order_id,
      ih.status = 'cancelled' as cancelled,
      (ih.status = 'completed'
        or ih.customer_shipped_at is not null
        or ih.customer_delivered_at is not null) as done,
      ih.customer_shipped_at   as shipped_at,
      ih.customer_delivered_at as delivered_at
    from covered c
    join public.orders ih on ih.order_ref = c.stock_order_number

    union all

    -- Outsourced production — the OUTBOUND (to customer) leg only.
    select
      c.id,
      oo.status = 'cancelled',
      (oo.status = 'shipped_to_customer'
        or oo.shipped_to_customer_at is not null
        or oo.customer_delivered_at is not null),
      oo.shipped_to_customer_at,
      oo.customer_delivered_at
    from covered c
    join public.outsourced_orders oo on oo.customer_order_ref = c.stock_order_number
  )
  select
    l.order_id,
    -- Latest dispatch across the legs. Can be NULL on a leg finished by status
    -- alone (the un-backfilled in-house rows above), so the caller must treat
    -- "a row exists" as the shipped signal, not "shipped_at is not null".
    max(l.shipped_at),
    -- Delivered only when EVERY live leg has been delivered — a two-leg order
    -- with one parcel still in transit is shipped, not delivered.
    case when count(*) = count(l.delivered_at) then max(l.delivered_at) end
  from legs l
  -- coalesce, not a bare `not l.cancelled` / bool_and(l.done): a NULL status
  -- would make `done` NULL, and bool_and SKIPS nulls, so an unknown leg would
  -- silently not count against the order and could suppress it. Unknown must
  -- read as "not done".
  where not coalesce(l.cancelled, false)
  group by l.order_id
  having bool_and(coalesce(l.done, false));
end;
$$;

revoke execute on function proofs.admin_order_shipping_state() from public, anon;
grant  execute on function proofs.admin_order_shipping_state() to authenticated;
