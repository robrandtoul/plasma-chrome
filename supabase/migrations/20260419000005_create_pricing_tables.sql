-- Live pricing used to pre-fill a new version's pricing_snapshot.
-- Not exposed to the public customer page — customers only see the
-- frozen snapshot on their proof version.

create table pricing_tables (
  id         uuid primary key default gen_random_uuid(),
  material   material_type not null,
  ink_count  int not null,
  currency   currency_type not null,
  tiers      jsonb not null,
  updated_at timestamptz default now(),
  unique (material, ink_count, currency)
);

create trigger pricing_tables_updated_at
  before update on pricing_tables
  for each row execute function update_updated_at();

-- RLS: readable and writable only by authenticated designers.
alter table pricing_tables enable row level security;

create policy "pricing_tables: authenticated select"
  on pricing_tables for select
  to authenticated
  using (true);

create policy "pricing_tables: authenticated insert"
  on pricing_tables for insert
  to authenticated
  with check (true);

create policy "pricing_tables: authenticated update"
  on pricing_tables for update
  to authenticated
  using (true);

create policy "pricing_tables: authenticated delete"
  on pricing_tables for delete
  to authenticated
  using (true);
