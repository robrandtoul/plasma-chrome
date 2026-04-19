-- Migration 000010: rebuild proof_versions to the v2 schema and add RLS
-- to the five pricing tables that 000009 created without policies.
--
-- proof_versions is rebuilt because the v1 schema had a flat material enum
-- and ink_count int; v2 references material_variants by FK and stores
-- denormalised display text so the customer page stays readable even if the
-- referenced variant is later retired.
--
-- proof_versions is empty at this point so a drop-and-recreate is safe.

begin;

-- ── 1. Drop dependent view first, then the old table ─────────────────────────

drop view if exists public_proof_versions;
drop table if exists proof_versions cascade;

-- ── 2. Recreate proof_versions with v2 schema ─────────────────────────────────

create table proof_versions (
  id                  uuid primary key default gen_random_uuid(),
  proof_id            uuid not null references proofs(id) on delete cascade,
  version_number      int not null,
  image_path          text not null,
  -- FK kept for traceability; nullable because a variant may be retired later.
  material_variant_id uuid references material_variants(id) on delete set null,
  -- Denormalised display text: source of truth on the customer page.
  material_display    text not null,
  variant_display     text not null,
  ink_names           text[] not null default '{}',
  currency            text not null check (currency in ('GBP','EUR','USD')),
  pricing_snapshot    jsonb not null,
  shipping_note       text not null default 'Prices exclude shipping',
  change_notes        text,
  is_current          boolean not null default false,
  created_at          timestamptz not null default now(),
  unique (proof_id, version_number)
);

-- ── 3. Triggers ───────────────────────────────────────────────────────────────

-- Auto-set version_number on insert.
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

-- On insert: make the new version current and unset all siblings.
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

-- On update of is_current to true: unset siblings.
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

-- Prevent any update to pricing_snapshot after insert.
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

-- ── 4. RLS on proof_versions ──────────────────────────────────────────────────

alter table proof_versions enable row level security;

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

-- ── 5. Recreate public_proof_versions view ────────────────────────────────────
-- Exposes only customer-safe columns; excludes material_variant_id (internal FK).

create or replace view public_proof_versions as
  select
    id,
    proof_id,
    version_number,
    image_path,
    material_display,
    variant_display,
    ink_names,
    currency,
    pricing_snapshot,
    shipping_note,
    change_notes,
    is_current,
    created_at
  from proof_versions;

grant select on public_proof_versions to anon, authenticated;

-- ── 6. RLS on the five pricing tables from migration 000009 ───────────────────
-- All pricing data is authenticated-only. Customers see only the frozen
-- pricing_snapshot on their proof version, never the live pricing tables.

alter table materials         enable row level security;
alter table material_variants enable row level security;
alter table price_tiers       enable row level security;
alter table add_ons           enable row level security;
alter table add_on_prices     enable row level security;

-- materials
create policy "materials: authenticated select"
  on materials for select to authenticated using (true);
create policy "materials: authenticated insert"
  on materials for insert to authenticated with check (true);
create policy "materials: authenticated update"
  on materials for update to authenticated using (true);
create policy "materials: authenticated delete"
  on materials for delete to authenticated using (true);

-- material_variants
create policy "material_variants: authenticated select"
  on material_variants for select to authenticated using (true);
create policy "material_variants: authenticated insert"
  on material_variants for insert to authenticated with check (true);
create policy "material_variants: authenticated update"
  on material_variants for update to authenticated using (true);
create policy "material_variants: authenticated delete"
  on material_variants for delete to authenticated using (true);

-- price_tiers
create policy "price_tiers: authenticated select"
  on price_tiers for select to authenticated using (true);
create policy "price_tiers: authenticated insert"
  on price_tiers for insert to authenticated with check (true);
create policy "price_tiers: authenticated update"
  on price_tiers for update to authenticated using (true);
create policy "price_tiers: authenticated delete"
  on price_tiers for delete to authenticated using (true);

-- add_ons
create policy "add_ons: authenticated select"
  on add_ons for select to authenticated using (true);
create policy "add_ons: authenticated insert"
  on add_ons for insert to authenticated with check (true);
create policy "add_ons: authenticated update"
  on add_ons for update to authenticated using (true);
create policy "add_ons: authenticated delete"
  on add_ons for delete to authenticated using (true);

-- add_on_prices
create policy "add_on_prices: authenticated select"
  on add_on_prices for select to authenticated using (true);
create policy "add_on_prices: authenticated insert"
  on add_on_prices for insert to authenticated with check (true);
create policy "add_on_prices: authenticated update"
  on add_on_prices for update to authenticated using (true);
create policy "add_on_prices: authenticated delete"
  on add_on_prices for delete to authenticated using (true);

commit;
