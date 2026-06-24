-- 000260: order revision status + revised_at + cancel/revision templates.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push` (the CLI link points at the retired standalone
-- project; pushing there would replay ~250 migrations into the stock app).
--
-- Order cancel & revision feature (docs/order-cancel-and-revision-spec.md).
-- Adds the 'revision' order status — a paid/placed order whose proof is being
-- redesigned and is HELD out of the placeable pipeline — a revised_at marker
-- for the "being revised since…" label, and the two customer-message templates.
--
-- Additive + safe: the new status value only widens the CHECK (no existing row
-- is invalidated — live values today are only sent/paid); revised_at is
-- nullable; the two templates are idempotent. No new grants: authenticated
-- already has full CRUD on proofs.orders, and new columns inherit it; no view
-- is recreated, so the "re-state grants" footgun does not apply here.

-- 1. Widen orders.status to include 'revision'. Drop + re-add the existing CHECK
--    (live name verified: orders_status_check) with all 7 values. drop-if-exists
--    + plain add is the idempotent, replay-safe pair (Postgres has no
--    IF NOT EXISTS for ADD CONSTRAINT). All 6 current values are re-listed so no
--    existing row (sent/paid today) is ever invalidated.
alter table proofs.orders
  drop constraint if exists orders_status_check;

alter table proofs.orders
  add constraint orders_status_check
  check (status = any (array[
    'draft', 'sent', 'paid', 'fulfilled', 'expired', 'cancelled', 'revision'
  ]));

-- 2. revised_at — stamped when an order enters 'revision' (drives the
--    "being revised since…" label; full detail lives in audit_log).
alter table proofs.orders
  add column if not exists revised_at timestamptz;

comment on column proofs.orders.revised_at is
  'When the order entered the ''revision'' hold (paid/placed order whose proof is being redesigned). Null = never revised.';

-- 3. The two admin-editable customer-message templates, posted as a
--    customer-visible Help Scout reply by the order-lifecycle edge function.
--    Bodies mirror DEFAULT_BODIES in src/lib/replyTemplates.ts and its
--    edge-function twin (supabase/functions/_shared/replyTemplates.ts), byte for
--    byte. No sign-off — Help Scout auto-appends the configured signature.
--    on conflict (id) do nothing → safe replay; admin edits win after first apply.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_cancelled',
    'Order cancelled',
    'Sent to the customer when an order/payment link is cancelled (customer aborted, or the proof is being reopened for changes). Variables: first_name, company.',
    'Hi {first_name},

We''ve cancelled the order and payment link for your cards{? company} for {company}{/?}. No payment has been taken.

If you''d like to go ahead after all, just reply and we''ll send a fresh link.'
  ),
  (
    'order_revision',
    'Order being revised',
    'Sent to the customer when a paid/placed order is held for a redesign — a fresh proof follows once it is re-approved. Variables: first_name, company.',
    'Hi {first_name},

We''re updating your cards{? company} for {company}{/?} — a fresh proof will follow shortly for you to approve before we go ahead.

If you have any questions in the meantime, just reply to this email.'
  )
on conflict (id) do nothing;
