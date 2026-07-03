-- 000298: open-spec orders — the customer chooses metal thickness / finish at
-- checkout (docs/metal-spec-at-checkout-spec.md, Move 2).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Four nullable-or-defaulted columns on proofs.orders, no new tables:
--
--   * material_id — the order's material, stamped by create-order on every new
--     order (derived from the chosen variant when one is locked; from the
--     builder's material when the spec is left open). Open-spec orders need it
--     because there is no variant to derive the material from: the pay page
--     filters the proof graph's variants/options by it, and
--     create-checkout-session validates the customer's choice against it.
--
--   * thickness_open / finish_open — explicit "customer chooses at checkout"
--     flags. Explicit rather than inferred from NULL columns because BOTH null
--     states are already taken: a null material_variant_id means "custom quote"
--     today, and a null material_option_id means "base / no finish". They also
--     survive the checkout persisting the customer's choice onto the order
--     (create-checkout-session re-reads the body choice on every call while the
--     flag is set — the same request-wins pattern the rating destination uses —
--     so "Edit order details" can change the pick before payment).
--
--   * help_requested_at — stamped by the new anon `order-question` edge
--     function when the customer uses the pay page's "Not sure? Ask us" escape
--     hatch. The Orders page shows an amber "asked for help" chip off it.
--
-- Grants: columns added to an existing table inherit its grants — nothing to
-- re-state. public_get_order returns to_jsonb(orders) minus the token, so all
-- four columns flow to the anon pay page automatically; none are sensitive.

alter table proofs.orders
  add column if not exists material_id uuid references proofs.materials(id),
  add column if not exists thickness_open boolean not null default false,
  add column if not exists finish_open boolean not null default false,
  add column if not exists help_requested_at timestamptz;

comment on column proofs.orders.material_id is
  'The order''s material. Stamped by create-order (from the locked variant, or the builder''s material for open-spec orders). Open-spec validation + the pay-page chooser key off it.';
comment on column proofs.orders.thickness_open is
  'Customer chooses the thickness (material variant) on the pay page. The chosen variant is validated + persisted by create-checkout-session before payment.';
comment on column proofs.orders.finish_open is
  'Customer chooses the finish (material option) on the pay page. Explicit flag because material_option_id NULL already means "base / no finish".';
comment on column proofs.orders.help_requested_at is
  'Most recent "Not sure? Ask us" question from the pay page (order-question edge fn). Surfaces as a help chip on the Orders page.';
