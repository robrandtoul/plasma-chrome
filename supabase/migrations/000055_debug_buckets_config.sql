create or replace function debug_buckets_config()
returns table (id text, name text, public boolean, file_size_limit bigint, allowed_mime_types text[])
language sql security definer set search_path = public, storage
as $$
  select id, name, public, file_size_limit, allowed_mime_types
  from storage.buckets
  where id in ('proof-images', 'material-icons')
$$;
grant execute on function debug_buckets_config() to authenticated;
