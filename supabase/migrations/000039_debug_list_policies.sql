create or replace function debug_list_policies()
returns table (tablename text, policyname text, cmd text, qual text, with_check text)
language sql security definer set search_path = public
as $$
  select schemaname || '.' || tablename, policyname, cmd, qual, with_check
  from pg_policies
  where schemaname = 'public'
    and tablename in ('materials','material_variants','price_tiers','add_ons','add_on_prices')
$$;
grant execute on function debug_list_policies() to authenticated;
