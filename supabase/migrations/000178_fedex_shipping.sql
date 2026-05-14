-- Migration 000178: international FedEx shipping in the Quote compiler.
--
-- Designer-only feature. Adds three pieces of schema:
--
--   1. material_variants.weight_grams — per-variant card weight, used
--      to derive parcel weight in the compiler. Default 10g so every
--      existing row trivially satisfies the CHECK and the compiler
--      can request a rate the moment the feature lands; admin
--      refines per variant from the new Card weights tab. Per-
--      variant rather than per-material because thickness drives
--      weight on the metal family especially.
--
--   2. settings.fedex_box_weight_grams + fedex_intl_adjust_percent —
--      the FedEx box's empty tare weight and the optional global
--      adjustment percentage the compiler layers on top of FedEx's
--      raw total. The 250g default for box weight is a placeholder;
--      Rob weighs the real box and sets it from Admin → Settings.
--      adjust_percent defaults to 0 (no adjustment). Both clamped
--      with CHECK constraints so a typo can't propagate.
--
--   3. fedex_rate_cache — server-side cache keyed on the four inputs
--      to a FedEx rate request (country, postcode, weight, currency).
--      The edge function reads-or-fills this row so repeat lanes
--      come back instantly and FedEx isn't hit on every keystroke.
--      The cache lifetime is enforced in the edge function (12h),
--      not in SQL, so the TTL can be tuned without a migration.
--
-- Customer-facing surfaces (public_* views, the anon RPC) are
-- deliberately untouched — shipping is a designer-only readout on
-- the Quote compiler and must not leak to /p/:id.
--
-- Grants: migration 000176 added ALTER DEFAULT PRIVILEGES so every
-- new table picks up CRUD for `authenticated` automatically. That's
-- fine for material_variants edits and settings updates (admin UI
-- writes go through authenticated sessions gated by RLS), but the
-- rate cache is service-role-only — the frontend never reads or
-- writes it. We REVOKE the defaulted grants and skip enabling RLS
-- with no policies, which is the explicit "no access for
-- authenticated, ever" stance.

begin;

-- ── material_variants.weight_grams ──────────────────────────────────
alter table material_variants
  add column weight_grams integer not null default 10
  check (weight_grams > 0);

comment on column material_variants.weight_grams is
  'Single-card weight in grams for this variant. Drives the parcel '
  'weight calculation in the Quote compiler (per-card weight × '
  'quantity + box tare). Per-variant rather than per-material because '
  'thickness materially changes weight on metal cards in particular. '
  'Default 10g so every existing variant has a working value the '
  'moment this migration lands; admin refines via the Card weights '
  'tab. CHECK > 0 prevents a typo from blanking the parcel weight.';

-- ── settings.fedex_box_weight_grams + fedex_intl_adjust_percent ─────
alter table settings
  add column fedex_box_weight_grams integer not null default 250
  check (fedex_box_weight_grams >= 0);

alter table settings
  add column fedex_intl_adjust_percent numeric(5,2) not null default 0
  check (fedex_intl_adjust_percent between -100 and 100);

comment on column settings.fedex_box_weight_grams is
  'Empty FedEx box tare weight in grams, added to the per-card '
  'weight × quantity figure to produce the parcel weight requested '
  'from FedEx. Default 250g is a placeholder — Rob weighs an empty '
  'box and updates this via Admin → Settings → Shipping.';

comment on column settings.fedex_intl_adjust_percent is
  'Global percentage applied to FedEx-quoted totals in the Quote '
  'compiler. Positive marks shipping up, negative marks down, 0 '
  'leaves the FedEx figure untouched. Applied frontend-side at '
  'render time (not in the edge function) so admin changes take '
  'effect immediately without invalidating the rate cache.';

-- ── fedex_rate_cache ────────────────────────────────────────────────
create table fedex_rate_cache (
  id            uuid primary key default gen_random_uuid(),
  dest_country  text not null,
  dest_postcode text not null,
  weight_grams  integer not null,
  currency      text not null,
  response      jsonb not null,
  fetched_at    timestamptz not null default now()
);

create unique index fedex_rate_cache_lookup_uq
  on fedex_rate_cache (dest_country, dest_postcode, weight_grams, currency);

comment on table fedex_rate_cache is
  'Server-side cache of FedEx rate responses, keyed on the four '
  'inputs that determine the rate (destination country + postcode, '
  'parcel weight in grams, and the currency the rate was requested '
  'in). The fedex-rate edge function reads-or-fills this row on '
  'every compiler-driven rate request. TTL enforced in the edge '
  'function (12h), so cache lifetime can be tuned without a '
  'migration. Frontend never touches this table — RLS is enabled '
  'with no policies and the authenticated CRUD grant defaulted by '
  '000176 is explicitly REVOKEd below.';

-- Frontend has no business reading or writing this cache. Strip the
-- CRUD grants that 000176's ALTER DEFAULT PRIVILEGES added on every
-- new table, and enable RLS with no policies so even a stray REST
-- call is denied at the database layer. This is the exact
-- "future SELECT-only tables need an explicit REVOKE" footgun
-- documented in CLAUDE.md, applied here in its no-access form.
revoke all on fedex_rate_cache from anon, authenticated;
alter table fedex_rate_cache enable row level security;

commit;
