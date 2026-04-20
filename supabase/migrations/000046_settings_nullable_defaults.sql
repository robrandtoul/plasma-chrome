-- Migration 000046: allow "no default" on designer defaults
--
-- default_pricing_display and default_currency become nullable, where
-- null means "force the designer to choose". The existing CHECK
-- constraints already treat null as passing, so non-null values stay
-- restricted to the same option sets. Reset both to null so the new
-- behaviour kicks in immediately.

begin;

alter table settings
  alter column default_pricing_display drop not null,
  alter column default_currency         drop not null;

update settings
  set default_pricing_display = null,
      default_currency         = null
  where id = 1;

commit;
