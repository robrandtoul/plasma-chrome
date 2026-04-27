-- 000115_add_vat_rate_gbp_setting.sql
--
-- Adds a configurable VAT rate to the settings singleton so the
-- quote compiler can render an ex-VAT figure beneath the inclusive
-- GBP headline without a code redeploy when HMRC changes the rate.
--
-- The compiler reads the GBP-stored prices as VAT-inclusive (per
-- Rob's pricing rules — see CLAUDE.md and the original 000009
-- pricing rebuild). To surface the ex-VAT figure we need to know
-- the rate. Hardcoding 0.20 would tie us to the UK standard rate;
-- a settings column lets an admin update it from the dashboard
-- and propagate within one cache TTL (60s).
--
-- Mirrors the shape of replies_enabled (000104): a column on the
-- existing settings singleton, not a key/value row. Validated
-- 0 ≤ rate ≤ 1 at the column level so a typo can't push prices to
-- absurd values; the admin UI also clamps but defence in depth.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so a second apply is a
-- no-op. The CHECK and COMMENT are wrapped in DO blocks so they
-- guard against re-creation if the column was already there.

begin;

alter table settings
  add column if not exists vat_rate_gbp numeric(5,4) not null default 0.20;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'settings_vat_rate_gbp_range'
  ) then
    alter table settings
      add constraint settings_vat_rate_gbp_range
      check (vat_rate_gbp >= 0 and vat_rate_gbp <= 1);
  end if;
end$$;

comment on column settings.vat_rate_gbp is
  'UK VAT rate applied to GBP-stored prices for the ex-VAT readout. '
  'Default 0.20 (20%, current UK standard). Range 0-1. '
  'GBP price_tiers rows are stored VAT-inclusive; this rate is used '
  'only to derive the ex-VAT figure shown alongside, never to '
  'modify the inclusive headline. EUR and USD prices are VAT-free '
  'and ignore this setting. Edits audited under '
  'setting.vat_rate_gbp_updated.';

commit;
