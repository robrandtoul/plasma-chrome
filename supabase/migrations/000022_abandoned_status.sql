-- Migration 000022: abandoned proof status
--
-- Adds 'abandoned' as a terminal lock state alongside 'approved'. Used when the
-- customer walks away from the design and the designer wants to close out the
-- work without it counting as an approval.
--
-- No trigger changes required:
--   * bump_proof_activity() (000018) only flips dormant → in_progress; all
--     other statuses (including abandoned) pass through unchanged.
--   * mark_dormant_proofs() (000019) only targets in_progress rows, so it
--     cannot downgrade an abandoned proof to dormant.

begin;

alter table proofs
  drop constraint if exists proofs_status_check;

alter table proofs
  add constraint proofs_status_check
    check (status in ('in_progress', 'approved', 'dormant', 'abandoned'));

alter table proofs
  add column abandoned_at timestamptz;

-- Expose abandoned_at through public_proofs. Drop-and-recreate (column count
-- changes) rather than create or replace.
drop view if exists public_proofs;

create view public_proofs as
  select
    p.id,
    c.full_name as customer_name,
    co.name     as company,
    p.created_at,
    p.status,
    p.approved_at,
    p.abandoned_at
  from proofs p
  join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

grant select on public_proofs to anon, authenticated;

commit;
