-- 000340 — One live pay link per project.
--
-- Two designers working the same approved proof from different locations
-- could each create an order, producing two live pay links for one project
-- (observed 2026-07-22: two identical Aeromynde.ai links 1.9s apart). The
-- proof page hides its "Create order" button when a link already exists, but
-- that check runs on the order list loaded when the page opened, so it can't
-- see a link a colleague created seconds ago. create-order now re-checks at
-- creation time against the live table and returns a friendly "already sent"
-- message; this partial unique index is the atomic backstop for the exact-
-- same-instant case that could slip between that check and the insert.
--
-- Scope: at most one order in the 'sent' (unpaid, live) state per proof,
-- ignoring combined-payment members (order_group_id set — those are managed
-- by the order-group flow). Paid / fulfilled / revision / cancelled orders,
-- and offline + reprint orders (born 'paid', never a pay link), are all
-- unaffected — so repeat orders, reprints, prototypes-after-payment and
-- combined payments keep working. Reactivating an expired link just pushes
-- expires_at forward on the same row, so it never trips this index either.

-- 1. Clear any pre-existing duplicate live links so the index can be built.
--    Keep the earliest 'sent' link per proof; cancel the rest. Idempotent:
--    a no-op once every proof has at most one ungrouped 'sent' order (so it
--    is safe to replay). No customer-facing message is sent — this is an
--    internal de-duplication, and the surviving link stays valid.
update proofs.orders o
set status = 'cancelled', updated_at = now()
where o.status = 'sent'
  and o.order_group_id is null
  and exists (
    select 1 from proofs.orders s
    where s.proof_id = o.proof_id
      and s.status = 'sent'
      and s.order_group_id is null
      and (s.sent_at < o.sent_at or (s.sent_at = o.sent_at and s.id < o.id))
  );

-- 2. Enforce it going forward.
create unique index if not exists orders_one_live_link_per_proof
  on proofs.orders (proof_id)
  where status = 'sent' and order_group_id is null;
