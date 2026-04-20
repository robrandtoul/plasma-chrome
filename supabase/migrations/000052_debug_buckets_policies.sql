create or replace function debug_storage_buckets_policies()
returns table (policyname text, cmd text, roles text, qual text, with_check text)
language sql security definer set search_path = public, storage
as $$
  select policyname, cmd, array_to_string(roles, ','), qual, with_check
  from pg_policies
  where schemaname = 'storage' and tablename = 'buckets'
$$;
grant execute on function debug_storage_buckets_policies() to authenticated;
