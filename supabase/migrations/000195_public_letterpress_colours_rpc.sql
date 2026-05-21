-- Migration 000195: public read access to letterpress core colours.
--
-- PlasmaDesign's separate Stock Control app needs to read this
-- project's letterpress colour palette as a live master list, so its
-- made-to-order letterpress fields can be picked from the same colours
-- managed here. The `letterpress_core_colours` table (added in 000133,
-- replaced/extended in 000134/000136) is not anon-readable: migration
-- 000176 left it without any anon GRANT, and the customer page never
-- needed it (letterpress core/front/back colours flow through the
-- per-proof anon RPC `public_get_customer_proof` added in 000162).
--
-- This migration follows the same anon-RPC house pattern as
-- public_get_lead_times (000180) and public_get_price_list (000184): a
-- SECURITY DEFINER function with EXECUTE granted to anon, returning a
-- tightly-scoped payload and nothing else. Exposed columns are limited
-- to name, hex_value and sort_order of active colours — id, timestamps
-- and the is_active flag itself are deliberately omitted.
--
-- Filtering on is_active = true means a colour deactivated via the
-- admin page automatically disappears for the consumer, mirroring the
-- in-app picker behaviour.

begin;

create or replace function public_get_letterpress_colours()
returns table (name text, hex_value text, sort_order int)
language sql
security definer
stable
set search_path = public
as $$
  select name, hex_value, sort_order
  from letterpress_core_colours
  where is_active = true
  order by sort_order, name;
$$;

grant execute on function public_get_letterpress_colours() to anon;

commit;
