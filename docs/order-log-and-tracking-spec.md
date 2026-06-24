# Build spec — Unified order log + (toggleable) customer order tracking

## Goal

Two linked outcomes, built on the realisation that **one customer order already has
two halves living in one database**:

- **proof-viewer (`proofs` schema)** owns the *commercial* half — customer, spec, price
  breakdown, payment, Xero invoice, the pay-link lifecycle.
- **Stock Control (`public` schema)** owns the *production* half — the in-house job
  (`public.orders`) or the outsourced job (`public.outsourced_orders`), including the
  shipment lifecycle and live carrier tracking.

So we do **not** build a third copy of the order record. We:

1. **Order log** — a single *shared view* that joins the two halves into one full-lifecycle
   record, surfaced as an Admin → Order log page (searchable, filterable, exportable). This
   replaces the current 30-row "Recently ordered" cap, which only ever shows proof-viewer's half.
2. **Customer order tracking** — a *separate, deliberately coarse projection* of that same data,
   surfaced to the customer, **built behind an off-by-default toggle** with per-route and
   per-supplier disclosure levels, so it can ship dormant and be dialled up as suppliers earn it.

Reorder (customer self-reorder) is **out of scope** for this spec — but the customer-facing
order-status surface here is the groundwork the reorder "customer order portal" will reuse.

---

## Background — confirmed against live data

| Fact | Detail |
| --- | --- |
| Same database | proof-viewer = `proofs` schema; Stock Control = `public` schema; both in project `bjvinrzbdrwebylkmbwy`. |
| Stock Control volume | 70 in-house jobs (`public.orders`), 102 outsourced jobs (`public.outsourced_orders`) — real, live data. |
| **Join key** | The 6-digit job number. proof-viewer `orders.stock_order_number` ↔ `public.orders.order_ref` (in-house) / `public.outsourced_orders.customer_order_ref` (outsourced). Both Stock Control sides also carry `inhouse_order_no` / the same value. |
| HS-id key (secondary) | `helpscout_conversation_id` matches for **in-house only** (6 live matches); **zero** for outsourced, because the outsourced hand-off opens a *separate supplier thread*. Use the job number as the universal key; HS id is an in-house-only fallback. |
| Caveat to confirm at build | proof-viewer's test orders aren't placed yet, so `stock_order_number` is still blank on them. Re-confirm `stock_order_number` equals the `403xxx` job number on the first real placed order before trusting the join in production. |

### Relevant Stock Control columns

`public.orders` (in-house): `order_ref`, `inhouse_order_no`, `customer_name`, `status`
(`pending` / `completed` …), `created_at`, `produced_at`, `completed_at`, `hard_deadline`,
`scheduling_done`, `cards_expected`, `finishing_quantity`, `helpscout_conversation_id`.
**No shipping/tracking fields** — in-house tops out at `completed_at`.

`public.outsourced_orders` (outsourced): `supplier_id`, `customer_order_ref`, `customer_name`,
`status` (`in_production` …), `in_production_at`, `shipped_from_supplier_at`, `arrived_at`,
`shipped_to_customer_at`, `cancelled_at`, `expected_ship_date`, `expected_arrival_date`,
`customer_deadline`, plus live carrier tracking: `tracking_status`, `tracking_status_code`,
`tracking_eta`, `tracking_last_event_at/location/description`, `customer_tracking_number`,
`tracking_sync_error`. `public.outsourced_order_tracking_events` holds the per-event history.

---

## Architecture decisions

- **Join, don't duplicate.** The order log is a *view/RPC over both schemas*, not a new table.
- **The job number is the spine.** `stock_order_number` is set at placement and is the
  route-agnostic order↔job key.
- **Cross-schema access.** A view in `proofs` that reads `public.orders` / `public.outsourced_orders`
  needs the reading role to have SELECT across both schemas. proof-viewer's `authenticated` role is
  not assumed to have SELECT on Stock Control's tables, so back the log with a **SECURITY DEFINER RPC**
  (`admin_search_orders`) owned by a role that can read both, gated on the caller being an admin/designer
  (role lookup on `auth.uid()`), rather than broadening `authenticated`'s grants on Stock Control tables.
  *(Verify the owning role's cross-schema read at build time; if a simple cross-schema GRANT is preferred,
  that's an alternative — decision noted below.)*
- **The customer projection is never a raw passthrough.** Map Stock Control's many statuses down to a
  tiny set of customer-safe stages; a disclosure level controls how much shows. This is what makes
  "hide supplier unreliability" structurally safe — at broad-brush there are no dates to miss.

---

## Phase 1 — Shared order log (ship first)

Pure read across the join. No customer exposure. Delivers the "look back on everything" ask.

**DB — migration `000NNN_order_log.sql`** *(pick the next free number via `ls supabase/migrations/0002*`):*

- `proofs.admin_search_orders(p_search text, p_status text, p_from date, p_to date, p_sort text, p_limit int, p_offset int)`
  - SECURITY DEFINER, `set search_path = proofs, public, extensions, pg_temp`.
  - Returns `jsonb` `{ total, orders: [...] }`.
  - First statement: assert the caller is an active admin/designer (`select role from proofs.profiles where id = auth.uid()`), else raise.
  - Body: select from `proofs.orders o`
    - `left join proofs.proofs pr on pr.id = o.proof_id`, `→ contacts → companies`
    - spec joins (`material_variants → materials`, `material_options`)
    - `left join public.orders ih on ih.order_ref = o.stock_order_number`
    - `left join public.outsourced_orders os on os.customer_order_ref = o.stock_order_number`
  - Search across `company / contact / payment_reference / stock_order_number / xero_invoice_id / project_name`.
  - **Status filter defaults to ALL** (incl. `cancelled` / `expired`) so the log is complete — unlike OrdersPage.
  - Date range on `paid_at` (fallback `created_at`).
  - `revoke execute … from anon, public; grant execute … to authenticated;`

**Frontend:**

- New route `/admin/orders` + one entry in `src/pages/admin/AdminLayout.tsx` TABS (already `RequireAdmin`-wrapped).
- New `src/pages/admin/AdminOrderLogPage.tsx` modelled on `CustomersPage.tsx` paging:
  columns — date (paid/created), company · contact, spec (material · variant, or "Custom quote"),
  qty, total, currency, **commercial status** pill, **production status** (in-house/outsourced + stage),
  payment_reference, Xero link, supplier/route, job number.
- Row → read-only **detail modal**: full `amount_*` breakdown, ship-to, `person_quantities`,
  **Dropbox folder link** (turns the log into the clickable index into the artwork archive),
  every commercial + production timestamp, tracking summary.
- Extract `orderTotal()` / `specLabel()` / `customerLabel()` from `OrdersPage.tsx` (≈ lines 137-163) into
  shared `src/lib/orderDisplay.ts` so the log and the work queue can't drift on displayed totals.

**Export:** new `export-orders` edge function cloned from `export-audit-log` (`requireAdmin`, same
query-string filters, no page cap, `text/csv` + `Content-Disposition`). Wire a CSV button on the page
via the `fetch(.../functions/v1/export-orders?…, { Authorization: Bearer access_token })` pattern.

**Effort:** S–M. One DEFINER RPC, one admin page reusing existing paging/helpers, one export fn. No new tables.

---

## Phase 2 — Order snapshot at placement (durability)

Today the order's spec is read *live* from the proof's current version; custom-quote orders store no
spec at all; the contact email is never stored on the order; and deleting a proof cascade-deletes its
orders. A small snapshot makes the log self-contained.

**DB — migration:**

- `alter table proofs.orders add column order_spec_snapshot jsonb;`
- Stamp it in `create-order` (and re-affirm at `place-order`): material code + display, variant, finish,
  ink_names, letterpress colours, quantity / person split, **contact email + company name as at order time**.
- (Optional) persist the composed production-note / supplier-email text so the exact hand-off is recoverable.

The admin log + export prefer the snapshot when present, falling back to the live join for older rows.

**Open decision (see below):** whether the log must survive a *proof deletion* (today `orders` cascade-
delete with the proof, and designers can delete proofs since 000243).

**Effort:** S. One nullable jsonb column + a few lines in the order edge functions.

---

## Phase 3 — Customer order tracking (scaffolded, OFF by default)

A separate, coarse projection of the production half, gated by disclosure settings. Ships dormant.

### Disclosure model

Three levels:

- **Off** — customer sees nothing after "Paid" (today's behaviour; the default everywhere).
- **Broad brush** — a date-free stage line: *Paid ✓ · In production · On its way · Delivered*.
  No ETA, no carrier link, no supplier named. With no promised date, a slipping supplier is invisible.
  "On its way" is held until the order genuinely ships.
- **Granular** — adds ETA + a live tracking link. For routes/suppliers you trust.

### Settings (in `proofs.settings`, admin-editable under Admin → Settings)

- `customer_tracking_enabled boolean default false` — master switch.
- `customer_tracking_config jsonb` — `{ inhouse: 'granular', outsourced_default: 'broad', suppliers: { "<supplier_id>": 'granular' } }`.
  - Per-route default; per-supplier override keyed on the Stock Control `supplier_id`
    (reachable via `outsourced_orders.supplier_id` in the join).
  - In-house defaults to `granular` (you control it); outsourced defaults to `broad`.
  - Resolution: master off → nothing; else supplier override → route default.

### Status → customer-stage mapping (the safe projection)

| Source | Customer stage (broad) | Granular adds |
| --- | --- | --- |
| In-house `pending` / not completed | In production | — (in-house has no shipping data) |
| In-house `completed_at` set | On its way / Complete | — |
| Outsourced `in_production` | In production | — |
| Outsourced `shipped_from_supplier_at` / `shipped_to_customer_at` | On its way | ETA (`tracking_eta` / `expected_arrival_date`) + tracking link (`customer_tracking_number`) |
| Outsourced `arrived_at` / delivered | Delivered | delivery date |
| any `cancelled_at` | (internal only — not shown) | — |

> **In-house has no shipping/tracking fields** (only `produced_at` / `completed_at`), so its customer
> view is naturally coarse — fine, since broad-brush is the safe default anyway.

### Surface

- A read path the customer reaches via their existing order/proof token (anon, token-scoped — same
  security model as `public_get_order`), returning **only the resolved, projected stage** for that order
  (never raw Stock Control rows). Computed server-side so the disclosure rules can't be bypassed client-side.
- Rendered on the pay-page "paid" state / proof page as a quiet status strip. Hidden entirely when the
  resolved level is `off` (so with the master switch off, nothing changes for customers).

**Effort:** M. The projection RPC + settings + admin controls + the customer strip. Ships behind the
off switch, so it's inert until you turn it on — and you turn it on per-route/per-supplier.

---

## Open questions / decisions

1. **Cross-schema access mechanism** — SECURITY DEFINER RPC (recommended; no grant changes to Stock
   Control tables) vs a direct cross-schema GRANT to `authenticated`. Confirm the owning role's reach at build.
2. **Log durability vs proof deletion** — orders cascade-delete with a proof (000243 lets designers delete
   proofs). Options: (a) soft-delete proofs; (b) change the FK to RESTRICT/SET NULL + an append-only log
   table; (c) keep cascade but warn loudly in the delete danger zone when paid/fulfilled orders exist.
3. **Where the log is *primarily* surfaced** — Admin → Order log in proof-viewer (this spec), or also a
   shared view Stock Control reads. Recommend proof-viewer admin first; the view/RPC is reusable either way.
4. **Join-key hardening** — rely on `stock_order_number` ↔ job number, or add an explicit
   `proofs.orders` ↔ Stock Control job id link at placement for a rock-solid FK once reorders create
   multiple orders per proof.
5. **Customer-tracking copy + stages** — confirm the exact stage labels and that "On its way" semantics
   match your in-house dispatch reality.

---

## Sequencing

1. **Phase 1** — shared order log + Admin page + CSV export. (Highest value, pure read, low risk.)
2. **Phase 2** — order snapshot at placement (durability; underpins reorder later).
3. **Phase 3** — customer tracking projection, shipped OFF, dialled up per-route/per-supplier as suppliers earn it.

Reorder (customer self-serve) is a separate later piece that reuses Phase 2's snapshot and Phase 3's
customer order surface.

---

## Gotchas

- **Cross-schema migration discipline:** schema-qualify everything; the proofs schema has no default
  privileges, so the new RPC needs an explicit `grant execute … to authenticated` + `revoke … from anon, public`.
- **In-house vs outsourced shape differs:** the join is two separate LEFT JOINs; exactly one should match a
  placed order (by route). Handle the "neither matched yet" (not placed) and "custom-quote / null spec" cases
  gracefully, as OrdersPage already does.
- **`supplier_id` has no FK** (cross-schema to `public.outsourced_suppliers`); the supplier name is the
  denormalised source if a supplier is renamed.
- **The customer projection must be server-computed** behind the disclosure settings — never ship raw
  tracking to the client and filter in the browser.
- **Numbering:** pick migration numbers via `ls supabase/migrations/0002*`, not from any doc (known
  duplicate-prefix collisions exist).
