-- One record per customer job. May have many proof_versions over time.
-- Internal columns (helpscout_thread_url, internal_notes) are hidden from
-- the public customer page via the public_proofs view (migration 007).

create table proofs (
  id                   uuid primary key default gen_random_uuid(),
  customer_name        text not null,
  company              text,
  helpscout_thread_url text,
  internal_notes       text,
  created_by           uuid references profiles(id),
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create trigger proofs_updated_at
  before update on proofs
  for each row execute function update_updated_at();

-- RLS
alter table proofs enable row level security;

-- Authenticated designers read everything (including internal columns).
create policy "proofs: authenticated select"
  on proofs for select
  to authenticated
  using (true);

-- Only the creating designer's session can insert, and created_by must match.
create policy "proofs: authenticated insert"
  on proofs for insert
  to authenticated
  with check (auth.uid() = created_by);

create policy "proofs: authenticated update"
  on proofs for update
  to authenticated
  using (true);

create policy "proofs: authenticated delete"
  on proofs for delete
  to authenticated
  using (true);

-- Public (anonymous) access to non-internal columns is provided by the
-- public_proofs view in migration 007, not by a policy on this table.
