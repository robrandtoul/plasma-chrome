-- Migration 000064: let the pricing-import RPC create new price tiers
--
-- 000042 defined apply_pricing_updates as an UPDATE-only path: three
-- kinds (price_tier, surcharge, add_on_price), each guarded by
-- `if not found then raise`. Phase 3b.3 extends the CSV import flow to
-- add new quantity tiers, which needs a fourth kind that INSERTs.
--
-- The existing three kinds stay bit-for-bit identical so the current
-- import flow is untouched. The new arm does an INSERT ... ON CONFLICT
-- DO NOTHING so that if the parser's preview view is stale (the admin
-- sat on it long enough for a manual add to race it), we don't
-- half-apply a batch. Only rows that actually landed count toward the
-- returned int.
--
-- Payload shape for the new kind:
--   {
--     "kind": "price_tier_created",
--     "material_variant_id": "<uuid>",
--     "currency": "GBP" | "EUR" | "USD",
--     "quantity": <int>,
--     "total_price": <numeric>,
--     "unit_price":  <numeric>
--   }
--
-- No `id` is supplied (it's generated server-side). The edge function
-- fetches the newly-minted IDs after commit if it needs them for
-- per-row audit events.

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
  inserted_count int;
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
      applied := applied + 1;
    elsif kind = 'price_tier_created' then
      insert into price_tiers (material_variant_id, currency, quantity, total_price, unit_price)
      values (
        (item->>'material_variant_id')::uuid,
        (item->>'currency')::char(3),
        (item->>'quantity')::int,
        (item->>'total_price')::numeric,
        (item->>'unit_price')::numeric
      )
      on conflict (material_variant_id, currency, quantity) do nothing;
      get diagnostics inserted_count = row_count;
      applied := applied + inserted_count;
    elsif kind = 'surcharge' then
      update materials
        set split_name_surcharge_gbp = nullif(item->>'gbp','')::numeric,
            split_name_surcharge_eur = nullif(item->>'eur','')::numeric,
            split_name_surcharge_usd = nullif(item->>'usd','')::numeric
        where id = (item->>'id')::uuid;
      if not found then
        raise exception 'material % not found', item->>'id';
      end if;
      applied := applied + 1;
    elsif kind = 'add_on_price' then
      update add_on_prices
        set surcharge = (item->>'surcharge')::numeric
        where id = (item->>'id')::uuid;
      if not found then
        raise exception 'add_on_price % not found', item->>'id';
      end if;
      applied := applied + 1;
    else
      raise exception 'Unknown update kind: %', kind;
    end if;
  end loop;

  return applied;
end;
$$;

grant execute on function apply_pricing_updates(jsonb) to authenticated;

commit;
