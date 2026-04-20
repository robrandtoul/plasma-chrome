-- Migration 000029: server-side guards for Customers page deletes
--
-- The Customers page lets designers remove empty contact and company
-- records. FK on-delete-restrict already blocks orphaning, but these
-- RPCs give a clean "guarded in a single transaction" path with
-- explicit error messages, and let the company-delete cascade into its
-- empty contacts in one atomic step.

begin;

-- Delete a contact only if it has no proofs. Raises a meaningful error
-- otherwise so callers can surface it to the designer.
create or replace function delete_contact_if_empty(p_contact_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  proof_count int;
begin
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

-- Delete a company only if every contact under it has no proofs. Any
-- contacts with zero proofs are removed first (the caller's intent is
-- "clear this whole company"), then the company row is deleted. The
-- function's implicit transaction makes this atomic.
create or replace function delete_company_if_empty(p_company_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  proof_count int;
begin
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

grant execute on function delete_contact_if_empty(uuid) to authenticated;
grant execute on function delete_company_if_empty(uuid) to authenticated;

commit;
