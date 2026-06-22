-- 000249: US tariff & customs handling service ($39, default-on, opt-out).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- WHY: since the US ended the $800 de-minimis import exemption (29 Aug 2025),
-- Plasma adds a flat handling service to US-bound orders that covers all
-- tariffs + customs clearance and is handled on the customer's behalf. It is
-- added by default and the customer can opt out (becoming responsible for US
-- Customs themselves). This was already the manual invoicing convention; this
-- migration teaches the new Ordering & checkout flow the same rule.
--
-- Three additive, low-risk pieces (all nullable or defaulted, so prod is inert
-- until a US order is priced):
--   1. orders     — the customer's opt-out flag + the charged tariff component
--                   (mirrors the amount_* breakdown from 000232).
--   2. settings   — the fee per currency, the Xero item code (910), and the
--                   editable customer copy (intro + opt-out warning).
--   3. public_settings() — surface the fee + copy on the anon RPC the pay-page
--                   reads (it can't read `settings` directly under RLS).

begin;

-- ── 1. orders: opt-out flag + tariff price component ──────────────────────
-- amount_us_tariff is nullable like the other amount_* columns (a non-US or
-- legacy order leaves it null). us_tariff_opted_out defaults false = "service
-- included", matching the default-on business rule. Both flow through
-- public_get_order automatically (it returns to_jsonb(o) - 'token').
alter table proofs.orders
  add column if not exists us_tariff_opted_out boolean not null default false,
  add column if not exists amount_us_tariff numeric(10,2)
    check (amount_us_tariff is null or amount_us_tariff >= 0);

-- ── 2. settings: fee per currency + Xero item code + customer copy ────────
-- Fees are NOT NULL DEFAULT 39 so the existing singleton row is backfilled to
-- 39 in each currency (US orders are billed in USD in practice; GBP/EUR are
-- editable defaults for the rare non-USD US order). A fee of 0 cleanly
-- disables the charge (the checkout + pay-page guard on fee > 0). settings
-- already carries authenticated CRUD + the public_settings() anon surface, so
-- no grant change is needed.
alter table proofs.settings
  add column if not exists us_tariff_fee_gbp numeric(10,2) not null default 39
    check (us_tariff_fee_gbp >= 0),
  add column if not exists us_tariff_fee_eur numeric(10,2) not null default 39
    check (us_tariff_fee_eur >= 0),
  add column if not exists us_tariff_fee_usd numeric(10,2) not null default 39
    check (us_tariff_fee_usd >= 0),
  add column if not exists xero_us_tariff_item_code text,
  add column if not exists us_tariff_intro_copy text,
  add column if not exists us_tariff_optout_warning text;

-- The Xero product/item code the tariff line invoices as. Pre-existing item
-- '910'. Seeded only when unset so re-running (or an admin edit) is a no-op.
update proofs.settings set xero_us_tariff_item_code = '910'
  where id = 1 and xero_us_tariff_item_code is null;

-- Customer-facing copy. Seeds mirror the defaults in src/lib/publicSettings.ts
-- (US_TARIFF_INTRO_COPY_DEFAULT / US_TARIFF_OPTOUT_WARNING_DEFAULT) so the
-- admin "reset to default" behaviour and the code fallback agree. The fee
-- amount is deliberately NOT in the intro copy — the pay-page renders the
-- amount on its own line in the order currency.
update proofs.settings set us_tariff_intro_copy = $copy$Since the United States ended the $800 "de minimis" import exemption on 29 August 2025, shipments to the US can attract import tariffs and customs clearance charges. This service covers those tariffs and clearance for your order and we handle them on your behalf — so there are no hold-ups at customs and no surprise bills when your cards arrive.$copy$
  where id = 1 and us_tariff_intro_copy is null;

update proofs.settings set us_tariff_optout_warning = $copy$If you remove this, you'll deal with US Customs directly and be responsible for any import tariffs and customs clearance charges they levy. That can hold your cards at the border and lead to an unexpected bill before they're released.$copy$
  where id = 1 and us_tariff_optout_warning is null;

-- ── 3. surface the fee + copy on public_settings() (anon pay-page read) ───
-- create or replace keeps the existing anon/authenticated EXECUTE grants;
-- restated below for idempotency. Body = the live definition (verified via
-- MCP against bjvinrzbdrwebylkmbwy) plus the five US-tariff fields. Fees are
-- returned per currency; the pay-page picks the one matching the order's
-- currency. search_path matches the live proofs convention.
create or replace function proofs.public_settings()
returns json
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select json_build_object(
    'disclaimer_text',                    disclaimer_text,
    'company_name',                       company_name,
    'reply_email',                        reply_email,
    'approve_confirmation_copy',          approve_confirmation_copy,
    'request_changes_confirmation_copy',  request_changes_confirmation_copy,
    'metal_thickness_notes',              metal_thickness_notes,
    'about_proof_copy',                   about_proof_copy,
    'qr_panel_intro_copy',                qr_panel_intro_copy,
    'qr_panel_vcard_copy',                qr_panel_vcard_copy,
    'login_headline',                     login_headline,
    'login_description',                  login_description,
    'login_stats',                        login_stats,
    'login_form_heading',                 login_form_heading,
    'login_form_subcopy',                 login_form_subcopy,
    'us_tariff_fee_gbp',                  us_tariff_fee_gbp,
    'us_tariff_fee_eur',                  us_tariff_fee_eur,
    'us_tariff_fee_usd',                  us_tariff_fee_usd,
    'us_tariff_intro_copy',               us_tariff_intro_copy,
    'us_tariff_optout_warning',           us_tariff_optout_warning
  )
  from settings where id = 1;
$$;

grant execute on function proofs.public_settings() to anon, authenticated;

commit;
