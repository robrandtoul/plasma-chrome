-- 000229: orders table (Ordering & checkout, Step 2 — the order object).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED v1, NOT YET APPLIED — for Rob's review before applying. The order
-- object hangs off a proof and is the record the customer pay-page reads and
-- the Stripe→Xero sync writes from. Shape follows docs/ordering-checkout-spec.md
-- "The order object". The proofs schema has NO default privileges, so every
-- grant is stated explicitly. Customer-facing surfaces are untouched here:
-- anon gets nothing — the pay-page will read a single order via a token-scoped
-- SECURITY DEFINER RPC later (the public_get_customer_proof pattern), never
-- this table directly.

create table if not exists proofs.orders (
  id              uuid primary key default gen_random_uuid(),
  proof_id        uuid not null references proofs.proofs(id) on delete cascade,

  -- Lifecycle: draft → sent (pay-link issued) → paid → fulfilled, plus the two
  -- off-ramps. The customer pay-page only ever acts on a 'sent' order.
  status          text not null default 'draft'
                    check (status in ('draft','sent','paid','fulfilled','expired','cancelled')),

  -- Locked line-item parameters. The final figures are computed at pay time
  -- from these (the pricing engine + interpolation), so the order stores the
  -- inputs, not a frozen total. material_variant_id is the chosen card; null
  -- only for a fully custom quote. quantity is null when the customer picks it
  -- on the pay-page (quantity-open) and set when the designer locks it.
  material_variant_id uuid references proofs.material_variants(id),
  quantity            integer check (quantity is null or quantity > 0),
  names_count         integer not null default 1 check (names_count >= 1),
  has_personalisation boolean not null default false,
  -- Custom-quote total in the order currency (VAT treatment per currency).
  -- Set when there's no grid price; null for a grid-priced order.
  custom_quote_total  numeric(10,2) check (custom_quote_total is null or custom_quote_total >= 0),

  -- Shipping is a chosen TREATMENT (a rule), not a number — the rule
  -- recomputes live as the customer changes quantity. shipping_charged is the
  -- resolved figure stamped at payment, in the order currency. UK defaults to
  -- the flat DPD rate (see the spec's locked domestic-UK decision).
  shipping_treatment  text not null default 'full_cost'
                        check (shipping_treatment in ('full_cost','goodwill','free','manual')),
  shipping_charged    numeric(10,2) check (shipping_charged is null or shipping_charged >= 0),

  currency        text not null check (currency in ('GBP','EUR','USD')),

  -- Customer pay-page access. `token` is the bearer in /order/:token;
  -- `expires_at` bounds how long a (shipping-quoted) offer stays payable.
  token           text not null unique,
  expires_at      timestamptz,

  -- Stripe ↔ Xero reconciliation (Architecture rule #2): the app stamps
  -- payment_reference on BOTH the Stripe payment and the Xero invoice so the
  -- existing near-real-time Stripe bank feed auto-matches the statement line
  -- to the invoice. xero_invoice_id is filled after the sync. The app never
  -- records the payment itself — the feed settles it.
  payment_reference text unique,
  xero_invoice_id   text,

  -- Audit.
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  paid_at         timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists orders_proof_id_idx on proofs.orders(proof_id);
create index if not exists orders_status_idx on proofs.orders(status);

-- RLS + explicit grants (the proofs schema has no default privileges, so a new
-- table is born with no grants at all — service_role included).
alter table proofs.orders enable row level security;

-- Designers (authenticated) manage orders from the builder; service_role (the
-- create-order edge function and the Stripe webhook → Xero sync) gets full
-- access. Anon gets NOTHING — see the header note on the token-scoped RPC.
grant select, insert, update, delete on proofs.orders to authenticated;
grant all on proofs.orders to service_role;
revoke all on proofs.orders from anon, public;

create policy orders_rw on proofs.orders
  for all to authenticated using (true) with check (true);
