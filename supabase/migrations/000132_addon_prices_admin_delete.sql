-- Migration 000132: allow admins to delete add_on_prices rows.
--
-- Migration 000037 deliberately left INSERT and DELETE policies off
-- "until phase 2 needed them" — INSERT was opened for the seed flow
-- in the same migration; DELETE stayed blocked. The PriceCell
-- clear-to-null work needs it now: clearing an add-on surcharge
-- cell DELETEs the row (the surcharge column is NOT NULL, so
-- "no surcharge configured" is row-absence rather than null).
-- Without this policy the DELETE silently affects 0 rows under
-- RLS — the optimistic UI filter still fires (cell drops to "—")
-- but the row stays in the DB and reappears on the next page load.

begin;

create policy "add_on_prices: admin delete"
  on add_on_prices for delete to authenticated
  using (is_admin());

commit;
