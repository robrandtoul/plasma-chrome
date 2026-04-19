-- Migration 000011: restructure proof_versions for multi-variant pricing
--
-- For materials where variant_type = 'thickness', a single proof image covers
-- all thicknesses and the customer chooses at order time. The previous schema
-- stored one variant FK per version; this schema embeds all exposed variants
-- inside pricing_snapshot so no row-per-variant fan-out is needed.
--
-- New pricing_snapshot shape (uniform for single and multi-variant):
--   {
--     "variants": [
--       { "variant_id": "<uuid>", "display": "0.5mm", "prices": {"100": 219, ...} }
--     ]
--   }
--
-- proof_versions is empty (only test data) so drop-and-recreate is safe.

begin;

drop view if exists public_proof_versions;
drop table if exists proof_versions cascade;

create table proof_versions (
  id               uuid primary key default gen_random_uuid(),
  proof_id         uuid not null references proofs(id) on delete cascade,
  version_number   int not null,
  image_path       text not null,
  -- FK for internal traceability; ON DELETE RESTRICT so we notice if a
  -- material is removed while live proofs reference it.
  material_id      uuid not null references materials(id) on delete restrict,
  -- Denormalised at insert time so the customer page remains readable if
  -- the material's display_name changes later.
  material_display text not null,
  ink_names        text[] not null default '{}',
  currency         text not null check (currency in ('GBP','EUR','USD')),
  -- See shape above. Immutability enforced by trigger below.
  pricing_snapshot jsonb not null,
  shipping_note    text not null default 'Prices exclude shipping',
  change_notes     text,
  is_current       boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (proof_id, version_number)
);

-- ── Triggers ──────────────────────────────────────────────────────────────────

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

create policy "proof_versions: public select"
  on proof_versions for select using (true);

create policy "proof_versions: authenticated insert"
  on proof_versions for insert to authenticated with check (true);

create policy "proof_versions: authenticated update"
  on proof_versions for update to authenticated using (true);

create policy "proof_versions: authenticated delete"
  on proof_versions for delete to authenticated using (true);

-- ── Public view ───────────────────────────────────────────────────────────────

create or replace view public_proof_versions as
  select
    id,
    proof_id,
    version_number,
    image_path,
    material_id,
    material_display,
    ink_names,
    currency,
    pricing_snapshot,
    shipping_note,
    change_notes,
    is_current,
    created_at
  from proof_versions;

grant select on public_proof_versions to anon, authenticated;

commit;
