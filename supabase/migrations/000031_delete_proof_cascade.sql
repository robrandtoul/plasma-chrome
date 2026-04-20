-- Migration 000031: hard-delete a proof and its versions atomically
--
-- "Abandon" is a soft state change (status = 'abandoned', record kept).
-- "Delete" is permanent removal so downstream cleanup flows (delete a
-- contact, delete a company) aren't blocked by stale proofs the designer
-- actually wants gone.
--
-- Nothing fancy here — the FK cascades on proof_versions and
-- proof_version_images take care of the rest. The function exists so
-- callers get a clear name + single-statement atomicity, and so future
-- safety checks can be added in one place.

begin;

create or replace function delete_proof_cascade(p_proof_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  if not exists (select 1 from proofs where id = p_proof_id) then
    raise exception 'Proof not found';
  end if;

  delete from proofs where id = p_proof_id;
end;
$$;

grant execute on function delete_proof_cascade(uuid) to authenticated;

commit;
