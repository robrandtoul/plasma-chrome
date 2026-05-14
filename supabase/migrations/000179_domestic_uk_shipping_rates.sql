-- Migration 000179: domestic UK shipping rates on settings.
--
-- The Quote compiler's shipping card already handles international
-- FedEx rates (migration 000178). UK domestic shipments via DPD
-- are quoted as flat rates that don't depend on weight or postcode
-- beyond the mainland/Northern Ireland split.
--
-- Two new columns on settings, both VAT-inclusive GBP (matching
-- the GBP pricing convention used everywhere else in the system):
--
--   * domestic_uk_mainland_rate_gbp — flat rate for UK mainland
--     deliveries. Default £12.90.
--   * domestic_uk_ni_rate_gbp       — flat rate for Northern
--     Ireland deliveries. Default £18.90.
--
-- The compiler detects NI from a postcode prefix of "BT" and uses
-- the matching rate; everything else under destCountry='GB' falls
-- to the mainland rate. EUR / USD displays convert the GBP base
-- via the same Frankfurter / ECB path FedEx rates already use.
--
-- Admin-editable via the Shipping section on /admin/settings —
-- one-off price changes (DPD adjustments, seasonal surcharges,
-- temporary promotions) don't need a redeploy.

begin;

alter table settings
  add column domestic_uk_mainland_rate_gbp numeric(8,2) not null default 12.90
  check (domestic_uk_mainland_rate_gbp >= 0);

alter table settings
  add column domestic_uk_ni_rate_gbp numeric(8,2) not null default 18.90
  check (domestic_uk_ni_rate_gbp >= 0);

comment on column settings.domestic_uk_mainland_rate_gbp is
  'Flat DPD shipping rate for UK mainland deliveries, GBP VAT-'
  'inclusive. Surfaced on the Quote compiler when the destination '
  'is GB without a BT-prefix postcode. Default £12.90.';

comment on column settings.domestic_uk_ni_rate_gbp is
  'Flat DPD shipping rate for Northern Ireland deliveries, GBP '
  'VAT-inclusive. Triggered when the destination is GB and the '
  'postcode starts with BT. Default £18.90.';

commit;
