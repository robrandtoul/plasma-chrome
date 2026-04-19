-- One immutable record per proof iteration. Nothing is ever overwritten.
-- Triggers handle version_number sequencing and is_current toggling.

create table proof_versions (
  id               uuid primary key default gen_random_uuid(),
  proof_id         uuid not null references proofs(id) on delete cascade,
  version_number   int not null,
  image_path       text not null,
  material         material_type not null,
  ink_count        int not null check (ink_count between 1 and 6),
  ink_names        text[] not null,
  currency         currency_type not null,
  pricing_snapshot jsonb not null,
  shipping_note    text not null default 'Prices exclude shipping',
  change_notes     text,
  is_current       boolean not null default false,
  created_at       timestamptz default now(),
  unique (proof_id, version_number)
);

-- ── Trigger 1: auto-set version_number on insert ─────────────────────────────
create or replace function set_version_number()
returns trigger language plpgsql as $$
declare
  next_version int;
begin
  select coalesce(max(version_number), 0) + 1
  into next_version
  from proof_versions
  where proof_id = new.proof_id;

  new.version_number := next_version;
  return new;
end;
$$;

create trigger proof_versions_set_version_number
  before insert on proof_versions
  for each row execute function set_version_number();

-- ── Trigger 2: on insert, make new version current and unset siblings ─────────
create or replace function set_is_current_on_insert()
returns trigger language plpgsql as $$
begin
  update proof_versions
  set is_current = false
  where proof_id = new.proof_id;

  new.is_current := true;
  return new;
end;
$$;

create trigger proof_versions_set_is_current
  before insert on proof_versions
  for each row execute function set_is_current_on_insert();

-- ── Trigger 3: on update of is_current to true, unset siblings ───────────────
create or replace function unset_sibling_is_current()
returns trigger language plpgsql as $$
begin
  if new.is_current = true and old.is_current = false then
    update proof_versions
    set is_current = false
    where proof_id = new.proof_id
      and id != new.id;
  end if;
  return new;
end;
$$;

create trigger proof_versions_unset_siblings
  after update of is_current on proof_versions
  for each row execute function unset_sibling_is_current();

-- ── Trigger 4: prevent updates to pricing_snapshot ───────────────────────────
create or replace function prevent_pricing_snapshot_update()
returns trigger language plpgsql as $$
begin
  if new.pricing_snapshot::text != old.pricing_snapshot::text then
    raise exception 'pricing_snapshot is immutable and cannot be updated after creation';
  end if;
  return new;
end;
$$;

create trigger proof_versions_immutable_pricing
  before update on proof_versions
  for each row execute function prevent_pricing_snapshot_update();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table proof_versions enable row level security;

-- Public (anonymous) can read all non-internal columns.
-- All columns in proof_versions are customer-safe (none are internal).
create policy "proof_versions: public select"
  on proof_versions for select
  using (true);

create policy "proof_versions: authenticated insert"
  on proof_versions for insert
  to authenticated
  with check (true);

create policy "proof_versions: authenticated update"
  on proof_versions for update
  to authenticated
  using (true);

create policy "proof_versions: authenticated delete"
  on proof_versions for delete
  to authenticated
  using (true);
