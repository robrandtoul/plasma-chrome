-- 000328_order_supplier_overs.sql
--
-- Spoilage overs for hybrid (outsourced-then-finished-in-house) orders.
--
-- A hybrid order has its base cards made by a supplier (the outsourced route) and
-- is then FOILED in-house. Foiling spoils some cards, so the supplier must make
-- MORE blanks than the customer bought — a spoilage "overs" buffer. The buffer
-- only ever pads the SUPPLIER order (the supplier email's `Qty:` line); the
-- customer's invoice and the in-house finishing target stay at the quantity the
-- customer actually bought.
--
-- This column records the extra number of cards added to the supplier order at
-- placement time. 0 = no overs — the default, and the case for every order that
-- is not foiled in-house. It is set MANUALLY on the place-order review screen
-- (there is no automatic default and no auto-detection); the place-order edge
-- function stamps it when a supplier order is placed, so the order log keeps a
-- record of how many spares were ordered.
--
-- Additive and inert on existing rows (every one gets 0). No grant changes: the
-- proofs.orders grant matrix already covers this new column for the roles that
-- read/write the table.

alter table proofs.orders
  add column if not exists supplier_overs integer not null default 0
    check (supplier_overs >= 0);

comment on column proofs.orders.supplier_overs is
  'Extra cards added to the SUPPLIER order for foiling/finishing spoilage on a hybrid order (0 = none). Pads only the supplier email Qty line; the customer invoice and in-house finishing target stay at the bought quantity. Set manually on the place-order review screen — no automatic default.';
