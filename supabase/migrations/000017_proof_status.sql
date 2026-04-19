-- Migration 000017: proof approval status
--
-- Adds status ('in_progress' | 'approved') and approved_at to proofs.
-- Updates public_proofs view to expose both fields to the customer page.

begin;

alter table proofs
  add column status text not null default 'in_progress'
    check (status in ('in_progress', 'approved')),
  add column approved_at timestamptz;

-- Recreate public_proofs view to include the new columns.
-- Preserves the existing join to contacts and companies.
create or replace view public_proofs as
  select
    p.id,
    c.full_name as customer_name,
    co.name     as company,
    p.created_at,
    p.status,
    p.approved_at
  from proofs p
  join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

-- Grant already exists on the view name; recreating the view preserves it,
-- but re-issue to be safe.
grant select on public_proofs to anon, authenticated;

commit;
