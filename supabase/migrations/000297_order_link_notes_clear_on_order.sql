-- 000297: Discard a Links-to-send note the moment an order is created.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- The order-link note (000296) explains why a proof is still in Links-to-send,
-- usually "waiting on the customer". Once an order link is sent the proof leaves
-- that worklist (keepApprovedNoOrder excludes any proof that has an order of any
-- status), so the note is spent and should be discarded.
--
-- Doing this with a DB trigger on proofs.orders — rather than from the
-- create-order edge function — means EVERY order-creation path clears the note
-- (online pay-link, offline/bank-transfer, reprint, prototype), and the
-- money-handling edge function doesn't have to be touched/redeployed. The note
-- table holds at most one row per proof (proof_id PK), so the delete is trivial;
-- on a proof that never had a note it's a harmless no-op.
--
-- SECURITY DEFINER so the delete succeeds regardless of which role inserted the
-- order (service_role for the edge function; the function owner has delete on the
-- note table); search_path pinned; EXECUTE revoked from callers (a trigger fires
-- regardless of EXECUTE — same hardening as 000182 / 000290 / 000296).

begin;

create or replace function proofs.orders_clear_link_note()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  delete from proofs.order_link_notes where proof_id = new.proof_id;
  return new;
end;
$$;

revoke execute on function proofs.orders_clear_link_note() from public, anon, authenticated;
grant execute on function proofs.orders_clear_link_note() to service_role;

create trigger orders_clear_link_note
  after insert on proofs.orders
  for each row execute function proofs.orders_clear_link_note();

commit;
