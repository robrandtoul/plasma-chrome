-- 000237: seed the order-builder "payment link" reply template.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- The order builder's "Send to customer" message was a hardcoded default in
-- the component. This makes it admin-editable like the other customer messages:
-- it seeds an `order_payment_link` reply_templates row so it appears under
-- Admin → Templates (in its own "Order messages" group, since the id isn't
-- proof_* / nudge_*). Same house pattern as 000102 / 000157 / 000207: seed
-- (id, display_name, description, body) once, ON CONFLICT (id) DO NOTHING so a
-- re-run is a no-op and later edits are admin-driven.
--
-- The body mirrors DEFAULT_BODIES.order_payment_link in src/lib/replyTemplates.ts
-- (the Reset-to-default source). {order_url} is substituted with the order's
-- pay-page link when the builder renders it. No sign-off — Help Scout appends
-- the configured signature (same convention as every other template body).

insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_payment_link',
    'Order payment link',
    'Sent from the order builder with the customer''s secure payment link. The designer can tweak it per-order before sending.',
    'Hi,

Your cards are approved and ready to order. You can choose your quantity, confirm delivery, and pay securely here:

{order_url}

If you have any questions, just reply to this email.'
  )
on conflict (id) do nothing;
