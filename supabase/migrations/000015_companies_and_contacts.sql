-- Migration 000015: relational companies + contacts model
--
-- Replaces the flat customer_name / company text columns on proofs with a
-- proper two-table model.  All existing data is test data with no real
-- customer records, so it is wiped cleanly.

begin;

-- ── 1. New tables ──────────────────────────────────────────────────────────────

create table companies (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive dedup: 'Acme Corp' and 'acme corp' are the same company.
create unique index companies_name_lower_idx on companies (lower(name));

create table contacts (
  id         uuid        primary key default gen_random_uuid(),
  company_id uuid        references companies(id) on delete restrict,
  full_name  text        not null,
  email      text        not null,
  created_at timestamptz not null default now()
);

-- Prevent duplicate emails within a company.
-- Partial index: NULL company_id rows are excluded because NULL != NULL in
-- Postgres unique checks — a separate constraint would be needed for individuals,
-- but the spec only requires within-company uniqueness.
create unique index contacts_company_email_idx
  on contacts (company_id, lower(email))
  where company_id is not null;

-- ── 2. Wipe test data ──────────────────────────────────────────────────────────

truncate proofs cascade;   -- cascades to proof_versions, proof_version_images

-- ── 3. Add contact FK to proofs ───────────────────────────────────────────────

alter table proofs
  add column contact_id uuid not null references contacts(id) on delete restrict;

-- ── 4. Drop old flat columns ──────────────────────────────────────────────────

drop view if exists public_proofs;

alter table proofs
  drop column customer_name,
  drop column company;

-- ── 5. Recreate public_proofs view ────────────────────────────────────────────

create view public_proofs as
  select
    p.id,
    c.full_name   as customer_name,
    co.name       as company,
    p.created_at
  from proofs p
  join contacts c        on c.id  = p.contact_id
  left join companies co on co.id = c.company_id;

grant select on public_proofs to anon, authenticated;

-- ── 6. RLS on new tables ──────────────────────────────────────────────────────

alter table companies enable row level security;

create policy "companies: authenticated read"
  on companies for select to authenticated using (true);
create policy "companies: authenticated insert"
  on companies for insert to authenticated with check (true);
create policy "companies: authenticated update"
  on companies for update to authenticated using (true);
create policy "companies: authenticated delete"
  on companies for delete to authenticated using (true);

alter table contacts enable row level security;

create policy "contacts: authenticated read"
  on contacts for select to authenticated using (true);
create policy "contacts: authenticated insert"
  on contacts for insert to authenticated with check (true);
create policy "contacts: authenticated update"
  on contacts for update to authenticated using (true);
create policy "contacts: authenticated delete"
  on contacts for delete to authenticated using (true);

commit;
