-- Migration 000030: Customers page delete RPCs ignore empty proofs
--
-- A proof row with no versions is just a stale shell — the designer
-- started a new project then never uploaded anything. The Customers
-- page counts "real" proofs as those with at least one version, so
-- the delete RPCs need to sweep away version-less shells before the
-- restrictive count check, otherwise the UI shows "No proofs" but
-- the delete button would error.

begin;

create or replace function delete_contact_if_empty(p_contact_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  proof_count int;
begin
  -- Sweep shells (no versions) for this contact.
  delete from proofs p
  where p.contact_id = p_contact_id
    and not exists (select 1 from proof_versions pv where pv.proof_id = p.id);

  -- Only "real" proofs remain — any at all means we can't delete.
  select count(*) into proof_count
  from proofs
  where contact_id = p_contact_id;

  if proof_count > 0 then
    raise exception 'Cannot delete contact: % proof(s) reference it', proof_count
      using errcode = 'restrict_violation';
  end if;

  delete from contacts where id = p_contact_id;
end;
$$;

create or replace function delete_company_if_empty(p_company_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  proof_count int;
begin
  -- Sweep shells (no versions) across all contacts in this company.
  delete from proofs p
  using contacts c
  where p.contact_id = c.id
    and c.company_id = p_company_id
    and not exists (select 1 from proof_versions pv where pv.proof_id = p.id);

  select count(*) into proof_count
  from proofs p
  join contacts c on c.id = p.contact_id
  where c.company_id = p_company_id;

  if proof_count > 0 then
    raise exception 'Cannot delete company: % proof(s) exist under its contacts', proof_count
      using errcode = 'restrict_violation';
  end if;

  delete from contacts where company_id = p_company_id;
  delete from companies where id = p_company_id;
end;
$$;

commit;
