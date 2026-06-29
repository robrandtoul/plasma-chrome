-- 000287: prototyping-service orders — a flat per-material-family fee.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this.
--
-- Plasma offers a prototyping service: up to three exact copies of an approved
-- design, charged at a flat fee per material family (NOT the per-quantity price
-- grid). The service is internal-only — never promoted on /p/:id or the
-- marketing site — but processed through the existing ordering machinery so it
-- bills, invoices, and fulfils like any order.
--
-- Two additive changes, both replay-safe:
--   1. orders.order_kind — distinguishes a 'prototype' order from a normal
--      'production' card order. A prototype is modelled as a custom-quote order
--      (custom_quote_total = the flat fee) that KEEPS its material_variant_id,
--      so the existing Xero item-code resolution books it to the right material
--      revenue account (Rob's call: reuse the material's own item codes). The
--      column lets the Orders page, the invoice label, and the
--      approved_no_order guard (000288) tell the two apart.
--   2. prototype_prices — the admin-editable flat fee, keyed by (family,
--      currency). family = materials.category exactly (verified live: metal,
--      carbon_fibre, acrylic, wood carry a fee; paper, plastic don't). Metal
--      and carbon_fibre each fold several material codes into one family fee,
--      so a per-family table (18 rows) is the honest grain rather than
--      per-currency columns duplicated across every metal code. Mirrors the
--      personalisation_pricing pattern (000172): rate only, read live, NEVER
--      snapshotted. GBP is VAT-inclusive; EUR/USD are VAT-free.
--
-- All six families are seeded so eligibility is admin-controlled too: paper +
-- plastic ship inactive (no fee), so an admin can switch a family on later from
-- Admin → Prototype prices without a code change. Eligibility for a family =
-- an active row with a non-null amount in the order's currency.

begin;

-- ── 1. orders.order_kind ───────────────────────────────────────────
-- public_get_order returns to_jsonb(orders), so this column is exposed to the
-- anon pay-page RPC automatically; orders already grants authenticated +
-- service_role, so the column inherits those — no grant or view change needed.

alter table proofs.orders
  add column if not exists order_kind text not null default 'production';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_order_kind_check'
  ) then
    alter table proofs.orders
      add constraint orders_order_kind_check
      check (order_kind in ('production', 'prototype'));
  end if;
end $$;

comment on column proofs.orders.order_kind is
  'production (default — a normal card order) or prototype (the flat-fee '
  'prototyping service: up to three copies of the approved design). A '
  'prototype is stored as a custom-quote order (custom_quote_total = the flat '
  'fee from prototype_prices) that keeps its material_variant_id for the Xero '
  'item code + shipping weight. Added in 000287.';

-- ── 2. prototype_prices ─────────────────────────────────────────────

create table if not exists proofs.prototype_prices (
  family     text not null
             check (family in ('metal', 'carbon_fibre', 'acrylic', 'wood', 'paper', 'plastic')),
  currency   text not null check (currency in ('GBP', 'EUR', 'USD')),
  -- The flat prototyping fee for this family/currency. Nullable so a family
  -- can exist as a row without a price yet (paper/plastic ship like this); a
  -- family is only orderable when is_active = true AND amount is set.
  amount     numeric(10,2) check (amount is null or amount > 0),
  is_active  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (family, currency)
);

comment on table proofs.prototype_prices is
  'Admin-editable flat fee for the prototyping service, keyed by material '
  'family (= materials.category) and currency. Read live by create-order and '
  'the order builder; never snapshotted. GBP VAT-inclusive, EUR/USD VAT-free. '
  'A family is orderable only when is_active AND amount is non-null — paper + '
  'plastic seed inactive so they can be enabled from the admin tab later.';

-- Seed. Metal / carbon fibre / acrylic / wood carry the brief's fees and ship
-- active. Paper + plastic ship inactive with no fee (admin enables later).
-- on conflict do nothing → safe replay.
insert into proofs.prototype_prices (family, currency, amount, is_active) values
  ('metal',        'GBP', 179, true),
  ('metal',        'EUR', 189, true),
  ('metal',        'USD', 189, true),
  ('carbon_fibre', 'GBP', 179, true),
  ('carbon_fibre', 'EUR', 189, true),
  ('carbon_fibre', 'USD', 189, true),
  ('acrylic',      'GBP', 89,  true),
  ('acrylic',      'EUR', 99,  true),
  ('acrylic',      'USD', 99,  true),
  ('wood',         'GBP', 59,  true),
  ('wood',         'EUR', 79,  true),
  ('wood',         'USD', 79,  true),
  ('paper',        'GBP', null, false),
  ('paper',        'EUR', null, false),
  ('paper',        'USD', null, false),
  ('plastic',      'GBP', null, false),
  ('plastic',      'EUR', null, false),
  ('plastic',      'USD', null, false)
on conflict (family, currency) do nothing;

-- RLS + grants. The proofs schema has NO default privileges of its own, but
-- 000176's ALTER DEFAULT PRIVILEGES grants authenticated full CRUD on every new
-- table — so revoke everything first and re-grant exactly what's wanted:
-- authenticated reads (admin editor + order builder) and updates (admin-gated
-- by RLS); never inserts/deletes (the 6×3 set is fixed). Anon gets nothing.
alter table proofs.prototype_prices enable row level security;

revoke all on proofs.prototype_prices from anon, authenticated, public;
grant select, update on proofs.prototype_prices to authenticated;
grant all on proofs.prototype_prices to service_role;

create policy "prototype_prices read for authenticated"
  on proofs.prototype_prices
  for select
  to authenticated
  using (true);

create policy "prototype_prices update for admin"
  on proofs.prototype_prices
  for update
  to authenticated
  using (proofs.is_admin())
  with check (proofs.is_admin());

commit;
