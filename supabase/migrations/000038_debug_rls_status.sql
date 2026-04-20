create or replace function debug_rls_status()
returns table (tablename text, rls_enabled boolean)
language sql security definer set search_path = public
as $$
  select c.relname::text, c.relrowsecurity
  from pg_class c
  where c.relname in ('materials','material_variants','price_tiers','add_ons','add_on_prices')
    and c.relkind = 'r'
$$;
grant execute on function debug_rls_status() to authenticated;
