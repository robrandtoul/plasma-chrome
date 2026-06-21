-- 000248: order-paid confirmation — branded Help Scout confirmation on payment.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- APPLIED 2026-06-21 via MCP apply_migration (name: order_paid_confirmation).
--
-- When a customer's payment lands, stripe-webhook posts a branded
-- order-paid confirmation on the proof's Help Scout thread (Help Scout emails
-- it to the customer). This migration adds:
--   1. two nullable timestamp markers on proofs.orders (one-shot guards +
--      visibility) — confirmation_sent_at backs the confirmation; invoice_emailed_at
--      is reserved for an optional emailed-invoice path (currently unused — the
--      pay-page's self-serve VAT-invoice link covers invoice delivery);
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
  'Reserved: when a Xero invoice was emailed to the customer (currently unused — pay-page self-serve link covers invoice delivery). Null = not sent.';
comment on column proofs.orders.confirmation_sent_at is
  'When the branded order-paid confirmation was posted to the customer on Help Scout (stripe-webhook). Null = not yet / no linked conversation.';

-- 2. the confirmation reply template (admin-editable; body mirrors
--    ORDER_CONFIRMATION_DEFAULT_BODY in both replyTemplates.ts twins). No
--    sign-off — Help Scout auto-appends the signature. Safe replay.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_paid_confirmation',
    'Order paid — confirmation',
    'Sent automatically when a customer''s payment lands: thanks, reference, and what happens next. Help Scout emails it to the customer.',
    'Hi {first_name},

Thank you — we''ve received your payment and your cards{? company} for {company}{/?} are now in production. Your order reference is {payment_reference}.

We''ll be in touch with dispatch details as soon as your cards are on their way.

If you have any questions, just reply to this email.'
  )
on conflict (id) do nothing;
