-- 000267_order_links_in_messages.sql
-- Expose the customer's order link (which doubles as the order-tracking page,
-- Phase 3) in the order messages.
--
-- 1. order_paid_confirmation — the auto-sent post-payment confirmation now links
--    back to the order page. The live body has been customised by the admin, so
--    rather than overwrite their wording we APPEND the {order_url} block once
--    (idempotent: skipped if the body already references order_url). The stripe-
--    webhook passes order_url, wrapped in a {? order_url}…{/?} conditional so the
--    line vanishes cleanly if the base URL is ever unset. Admin can reposition or
--    remove it from Admin → Templates.
-- 2. order_confirmation_link — a new template the designer sends from the order
--    builder for an OFFLINE (bank-transfer) order, where no pay link goes out. No
--    "pay" language (it's already recorded as paid); just confirms the order and
--    links to the order/tracking page.

update proofs.reply_templates
   set body = body || E'{? order_url}\n\nYou can view your order here, where it''ll show its progress as we make and ship it:\n\n{order_url}{/?}',
       updated_at = now()
 where id = 'order_paid_confirmation'
   and body not like '%{order_url}%';

insert into proofs.reply_templates (id, display_name, description, body)
values (
  'order_confirmation_link',
  'Order confirmation (offline)',
  'Sent by the designer from the order builder for an offline (bank-transfer) order — confirms the order and links to the order page, which doubles as the tracking page once customer tracking is enabled. Only {order_url} is substituted.',
  E'Hi,\n\nThank you for your order — it''s confirmed and on its way into production. You can view your order here, where it''ll show its progress as we make and ship it:\n\n{order_url}\n\nIf you have any questions, just reply to this email.'
)
on conflict (id) do nothing;
