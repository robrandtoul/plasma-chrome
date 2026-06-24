-- 000255_order_card_discount.sql
--
-- Designer-set, per-order discount on the CARDS line. Mirrors the shipping
-- subsidy (shipping_treatment + shipping_discount_percent): the designer picks a
-- discount when creating the order; the discount AMOUNT is resolved + capped at
-- checkout (create-checkout-session) against the priced cards figure and stamped
-- as amount_card_discount. It rides as its own negative line on the pay page and
-- the Xero invoice (cards line stays at full price so the customer sees the
-- saving), and nets off the charged total.
--
--   * card_discount_type  — none | percent | fixed (designer's choice)
--   * card_discount_value — the % (0–100) or fixed amount; null when none
--   * card_discount_reason— optional internal audit note
--   * amount_card_discount— the resolved discount stamped at checkout (>= 0),
--     alongside the other amount_* breakdown columns
--
-- proofs.orders already grants authenticated CRUD + service_role (000176/000229),
-- and public_get_order returns to_jsonb(orders) so the pay page sees the new
-- amount_card_discount automatically — no grant or function change needed.

alter table proofs.orders
  add column if not exists card_discount_type text not null default 'none'
    check (card_discount_type in ('none', 'percent', 'fixed')),
  add column if not exists card_discount_value numeric(10, 2)
    check (card_discount_value is null or card_discount_value >= 0),
  add column if not exists card_discount_reason text,
  add column if not exists amount_card_discount numeric(10, 2)
    check (amount_card_discount is null or amount_card_discount >= 0);
