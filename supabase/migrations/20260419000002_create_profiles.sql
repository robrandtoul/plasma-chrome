-- Extends the built-in Supabase auth user with a display name.

create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text,
  created_at timestamptz default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- RLS: each profile is readable and writable only by its owner.
alter table profiles enable row level security;

create policy "profiles: owner select"
  on profiles for select
  using (auth.uid() = id);

create policy "profiles: owner update"
  on profiles for update
  using (auth.uid() = id);
