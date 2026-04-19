-- Migration 000018: dormant proof status + activity tracking

begin;

alter table proofs
  drop constraint if exists proofs_status_check;

alter table proofs
  add constraint proofs_status_check
    check (status in ('in_progress', 'approved', 'dormant'));

alter table proofs
  add column last_activity_at timestamptz not null default now();

-- Backfill from the most recent version, falling back to proof creation date
update proofs p
set last_activity_at = greatest(
  p.created_at,
  coalesce((select max(created_at) from proof_versions where proof_id = p.id), p.created_at)
);

-- Trigger: bump last_activity_at on the parent proof whenever a version is inserted/updated.
-- Also wakes a dormant proof back to in_progress automatically.
create or replace function bump_proof_activity()
returns trigger as $$
begin
  update proofs
  set last_activity_at = now(),
      status = case when status = 'dormant' then 'in_progress' else status end
  where id = new.proof_id;
  return new;
end;
$$ language plpgsql;

create trigger proof_versions_bump_activity
  after insert or update on proof_versions
  for each row execute function bump_proof_activity();

commit;
