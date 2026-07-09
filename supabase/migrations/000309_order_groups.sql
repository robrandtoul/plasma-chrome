-- 000309_order_groups.sql
-- Bundle orders Slice 2 — the order-group money engine
-- (docs/bundle-orders-spec.md §2/§6/§13; design note docs/order-groups-slice2.md).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration Rob
-- approves. Do NOT use `supabase db push`.
--
-- WHAT THIS IS, in plain English: a designer can now put two or more existing
-- orders (each its own proof, its own production record) into ONE payment
-- group, and the customer pays ONCE for the lot. The group is a thin money
-- shell sitting ABOVE the orders:
--
--   * MONEY converges up to the group — one pay link, one Stripe payment, one
--     payment_reference, one Xero invoice, one confirmation, one VAT-invoice
--     email. All the "did we already do this" flags live here so a Stripe
--     retry can never double-invoice (done-once per group, spec §6).
--   * MAKING stays per order — supplier, production route, stock order number,
--     Dropbox folder, date required, tracking and fulfilled_at all stay on
--     proofs.orders, exactly as today. Each card is produced and shipped
--     independently; the group never blocks a card from dispatching.
--
-- The group also owns the ONE combined-shipping BILLING decision (spec §8
-- default: bill one combined parcel; per-card dispatch is a fulfilment
-- capability, not a re-bill) and the single US tariff line for a US-bound
-- group. Fields deliberately mirror proofs.orders so the checkout + webhook
-- code reads the same either way.

-- ── 1. The group table ────────────────────────────────────────────────────
create table proofs.order_groups (
  id uuid primary key default gen_random_uuid(),
  -- sent = pay link live · paid = money received · cancelled = dissolved
  -- before payment. No draft (groups are created ready-to-send) and no
  -- fulfilled (fulfilment is per member order).
  status text not null default 'sent'
    check (status in ('sent', 'paid', 'cancelled')),
  -- One currency per group (spec §7). Members must match; the edge function
  -- enforces it and this CHECK documents the invariant.
  currency text not null check (currency in ('GBP', 'EUR', 'USD')),

  -- Combined shipping BILLING for the whole group (same vocabulary as
  -- orders.shipping_treatment): full_cost / goodwill rate ONE consignment
  -- live at checkout (FedEx on the combined weight, or the UK flat rate);
  -- manual = the designer's fixed figure; free = 0.
  shipping_treatment text not null default 'full_cost'
    check (shipping_treatment in ('full_cost', 'goodwill', 'free', 'manual')),
  shipping_charged numeric(10,2)
    check (shipping_charged is null or shipping_charged >= 0),
  shipping_discount_percent numeric(5,2)
    check (shipping_discount_percent is null
           or (shipping_discount_percent >= 0 and shipping_discount_percent <= 100)),

  -- ONE delivery destination (spec §7: one address per group). Starts as the
  -- designer's hint; create-checkout-session overwrites it with the
  -- customer-entered rating destination, exactly like single orders.
  ship_dest_country text
    check (ship_dest_country is null or ship_dest_country ~ '^[A-Z]{2}$'),
  ship_dest_postcode text,

  -- Money outcomes stamped at checkout: the ONE combined shipping figure and
  -- the ONE US tariff line (a group is one customs entry by default, spec §8).
  -- Per-card goods figures stay on each member order (amount_cards etc.).
  amount_shipping numeric(10,2)
    check (amount_shipping is null or amount_shipping >= 0),
  amount_us_tariff numeric(10,2)
    check (amount_us_tariff is null or amount_us_tariff >= 0),
  us_tariff_opted_out boolean not null default false,

  -- The group pay link: /order/group/:id?token=…  Same bearer-token posture
  -- as orders.token; same expiry semantics (checkout refuses past expires_at,
  -- a designer can extend). Member orders' own links are NOT payable while
  -- they belong to an active group.
  token text not null,
  expires_at timestamptz,

  -- The 1:1 reconciliation spine (spec §6): stamped on the Stripe
  -- PaymentIntent AND the Xero invoice, so the bank-feed match works exactly
  -- as for single orders. GRP- prefix so combined payments are recognisable
  -- in Xero. One payment → one reference → one invoice.
  payment_reference text not null,

  -- Xero binding + done-once outcome flags (all mirror proofs.orders):
  -- the invoice is created once (xero_invoice_id), emailed once
  -- (invoice_emailed_at), and the Help Scout confirmation posts once
  -- (confirmation_sent_at) — webhook retries check these before acting.
  xero_contact_id text,
  xero_contact_name text,
  xero_invoice_id text,
  xero_invoice_error text,
  invoice_emailed_at timestamptz,
  confirmation_sent_at timestamptz,

  -- Delivery details Stripe collected, persisted by the webhook on the
  -- sent → paid flip (also copied onto each member for fulfilment).
  ship_to_name text,
  ship_to_email text,
  ship_to_address jsonb,

  -- Most recent customer open of the group pay page (mirror of
  -- orders.pay_link_opened_at; stamped via the anon RPC below).
  pay_link_opened_at timestamptz,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table proofs.order_groups is
  'One combined payment over N member orders (orders.order_group_id). Owns the money fields — token/pay link, payment_reference, combined shipping + US tariff billing, Xero invoice + done-once flags. Fulfilment stays per member order. Bundle orders Slice 2 (docs/bundle-orders-spec.md).';
comment on column proofs.order_groups.payment_reference is
  'Stamped on the Stripe payment and the Xero invoice (GRP- prefix). One payment -> one reference -> one invoice, same bank-feed match as single orders.';
comment on column proofs.order_groups.amount_shipping is
  'The ONE combined shipping figure charged for the group (billing). Per-card dispatch stays a fulfilment decision on each order.';

-- ── 2. Membership: orders → their group ───────────────────────────────────
-- Nullable: a standalone order has none. ON DELETE SET NULL so removing a
-- group (no UI for it today, but e.g. a test cleanup) releases members back
-- to standalone rather than deleting production records.
alter table proofs.orders
  add column if not exists order_group_id uuid
    references proofs.order_groups(id) on delete set null;

comment on column proofs.orders.order_group_id is
  'The combined-payment group this order belongs to (proofs.order_groups); null = standalone. While the group is active (sent) the member''s own pay link is not payable.';

create index if not exists orders_order_group_id_idx
  on proofs.orders (order_group_id)
  where order_group_id is not null;

-- ── 3. Grants + RLS ────────────────────────────────────────────────────────
-- The proofs schema has NO default privileges — every new table must state
-- its full grant matrix or the edge functions silently lose access (CLAUDE.md
-- / spec §11). Mirror proofs.orders exactly: designers get CRUD (the Orders
-- page manages groups under RLS), service_role gets everything (checkout +
-- webhook), anon gets nothing (the pay page reads via the token-gated RPC).
grant select, insert, update, delete on proofs.order_groups to authenticated;
grant all on proofs.order_groups to service_role;
revoke all on proofs.order_groups from anon, public;

alter table proofs.order_groups enable row level security;

-- Same shape as orders_rw: any authenticated designer can manage any group.
create policy order_groups_rw on proofs.order_groups
  for all to authenticated using (true) with check (true);

-- ── 4. Anon read path for the group pay page ──────────────────────────────
-- Same house pattern as public_get_order (000230): SECURITY DEFINER, scoped
-- to the group id AND its secret token, token stripped from the payload.
-- Returns the group plus its member orders (each minus ITS token — a group
-- link must not hand out the members' standalone pay links), ordered oldest
-- first, plus the first member's company/contact name for the page header.
-- Member rows carry order_spec_snapshot, so the page can label each card
-- without further queries.
create or replace function proofs.public_get_order_group(p_group_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'group', to_jsonb(g) - 'token',
    'orders', coalesce(
      (
        select jsonb_agg(to_jsonb(o) - 'token' order by o.created_at, o.id)
        from proofs.orders o
        where o.order_group_id = g.id
      ),
      '[]'::jsonb
    ),
    'company_name', (
      select coalesce(co.name, c.full_name)
      from proofs.orders o2
      join proofs.proofs p on p.id = o2.proof_id
      left join proofs.contacts c on c.id = p.contact_id
      left join proofs.companies co on co.id = c.company_id
      where o2.order_group_id = g.id
      order by o2.created_at, o2.id
      limit 1
    )
  )
  from proofs.order_groups g
  where g.id = p_group_id
    and g.token = p_token;
$$;

revoke all on function proofs.public_get_order_group(uuid, text) from public;
grant execute on function proofs.public_get_order_group(uuid, text) to anon, authenticated;

-- ── 5. Stamp "customer opened the group pay page" ─────────────────────────
-- Mirror of record_order_pay_link_opened (000262): token-validated, only
-- while the group is still payable, overwrites so the column holds the most
-- recent open.
create or replace function proofs.record_order_group_pay_link_opened(p_group_id uuid, p_token text)
returns void
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  update proofs.order_groups
     set pay_link_opened_at = now()
   where id = p_group_id
     and token = p_token
     and status = 'sent';
$$;

revoke all on function proofs.record_order_group_pay_link_opened(uuid, text) from public;
grant execute on function proofs.record_order_group_pay_link_opened(uuid, text) to anon, authenticated;

-- ── 6. Let the single-order pay page see "this order pays via a group" ────
-- public_get_order already returns the whole order row (so order_group_id
-- now flows automatically); add the GROUP's status so the page can show the
-- "this order is paid together with others" state only while the group is
-- actually active. Same signature → CREATE OR REPLACE; grants re-stated for
-- fresh-replay correctness.
create or replace function proofs.public_get_order(p_order_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select (to_jsonb(o) - 'token')
         || jsonb_build_object(
              'order_group_status',
              (select g.status from proofs.order_groups g where g.id = o.order_group_id)
            )
  from proofs.orders o
  where o.id = p_order_id
    and o.token = p_token;
$$;

revoke all on function proofs.public_get_order(uuid, text) from public;
grant execute on function proofs.public_get_order(uuid, text) to anon, authenticated;
