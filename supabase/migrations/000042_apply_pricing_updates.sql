-- Migration 000042: atomic commit path for CSV import
--
-- The import-pricing edge function computes a diff in memory, sends it
-- here as a JSON array, and this RPC applies every row inside a single
-- transaction. If any row errors, the whole import rolls back — that's
-- the atomicity guarantee the spec asks for.
--
-- Three update kinds are supported, each keyed by a public.* id:
--   price_tier  → price_tiers(total_price, unit_price)
--   surcharge   → materials(split_name_surcharge_{gbp,eur,usd})
--   add_on_price → add_on_prices(surcharge)

begin;

create or replace function apply_pricing_updates(updates jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  kind text;
  applied int := 0;
begin
  -- Only admins may commit a pricing import.
  if not is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  for item in select * from jsonb_array_elements(updates) loop
    kind := item->>'kind';
    if kind = 'price_tier' then
      update price_tiers
        set total_price = (item->>'total_price')::numeric,
            unit_price  = (item->>'unit_price')::numeric
        where id = (item->>'id')::uuid;
      if not found then
        raise exception 'price_tier % not found', item->>'id';
      end if;
    elsif kind = 'surcharge' then
      update materials
        set split_name_surcharge_gbp = nullif(item->>'gbp','')::numeric,
            split_name_surcharge_eur = nullif(item->>'eur','')::numeric,
            split_name_surcharge_usd = nullif(item->>'usd','')::numeric
        where id = (item->>'id')::uuid;
      if not found then
        raise exception 'material % not found', item->>'id';
      end if;
    elsif kind = 'add_on_price' then
      update add_on_prices
        set surcharge = (item->>'surcharge')::numeric
        where id = (item->>'id')::uuid;
      if not found then
        raise exception 'add_on_price % not found', item->>'id';
      end if;
    else
      raise exception 'Unknown update kind: %', kind;
    end if;
    applied := applied + 1;
  end loop;

  return applied;
end;
$$;

grant execute on function apply_pricing_updates(jsonb) to authenticated;

commit;
