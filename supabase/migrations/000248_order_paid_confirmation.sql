-- 000248: order-paid confirmation — emailed VAT invoice + branded confirmation.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- APPLIED 2026-06-21 via MCP apply_migration (name: order_paid_confirmation).
--
-- When a customer's payment lands, stripe-webhook (a) emails the Xero invoice
-- it creates to the customer as their VAT receipt, and (b) posts a branded
-- order-paid confirmation on the proof's Help Scout thread (Help Scout emails
-- it). This migration adds:
--   1. two nullable timestamp markers on proofs.orders — one-shot guards +
--      Orders-page visibility for those two actions;
--   2. the admin-editable order_paid_confirmation reply template.
--
-- Additive + inert: new nullable columns default null, the webhook only acts
-- once a real payment lands, and the ordering feature stays toggle-gated. The
-- existing approve → manual-invoice flow is untouched.

-- 1. per-action one-shot / visibility markers (new nullable columns inherit
--    the table's grants, so no grant statements are needed here).
alter table proofs.orders
  add column if not exists invoice_emailed_at timestamptz,
  add column if not exists confirmation_sent_at timestamptz;

comment on column proofs.orders.invoice_emailed_at is
  'When the Xero invoice was emailed to the customer as their VAT receipt (stripe-webhook). Null = not yet / not applicable.';
comment on column proofs.orders.confirmation_sent_at is
  'When the branded order-paid confirmation was posted to the customer on Help Scout (stripe-webhook). Null = not yet / no linked conversation.';

-- 2. the confirmation reply template (admin-editable; body mirrors
--    ORDER_CONFIRMATION_DEFAULT_BODY in both replyTemplates.ts twins). No
--    sign-off — Help Scout auto-appends the signature. Safe replay.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_paid_confirmation',
    'Order paid — confirmation',
    'Sent automatically when a customer''s payment lands: thanks, reference, and what happens next. Help Scout emails it to the customer (the Xero VAT invoice goes out as a separate email).',
    'Hi {first_name},

Thank you — we''ve received your payment and your cards{? company} for {company}{/?} are now in production. Your order reference is {payment_reference}.

We''ll email you dispatch details as soon as your cards are on their way, and your VAT invoice will arrive in a separate email shortly.

If you have any questions, just reply to this email.'
  )
on conflict (id) do nothing;
