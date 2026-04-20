create or replace function debug_storage_rls_status()
returns table (tablename text, rls_enabled boolean)
language sql security definer set search_path = public, storage
as $$
  select c.relname::text, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relkind = 'r'
$$;
grant execute on function debug_storage_rls_status() to authenticated;
