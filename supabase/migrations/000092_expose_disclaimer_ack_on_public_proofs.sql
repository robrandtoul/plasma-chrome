-- Migration 000092: expose disclaimer_acknowledged_at on public_proofs
--
-- Customer page needs to read the acknowledgement timestamp so
-- the disclaimer checkbox can render as ticked + disabled on
-- return visits without waiting for an edge-function round-
-- trip. Only the timestamp is surfaced — the audit fields
-- (ip / ua / by_name) stay on the base table.
--
-- Preserves the 000089 projection verbatim and appends
-- p.disclaimer_acknowledged_at at the end.

begin;

drop view if exists public_proofs;

create view public_proofs as
  select
    p.id,
    c.full_name as customer_name,
    co.name     as company,
    p.created_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.helpscout_conversation_id,
    p.disclaimer_acknowledged_at
  from proofs p
  join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

grant select on public_proofs to anon, authenticated;

commit;
