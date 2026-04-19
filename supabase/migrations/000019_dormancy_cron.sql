-- Migration 000019: scheduled dormancy job
--
-- Requires pg_cron. Enable under Database → Extensions in the Supabase dashboard
-- before applying this migration.

create extension if not exists pg_cron;

-- Function: flip in_progress proofs to dormant when inactive for 30+ days
create or replace function mark_dormant_proofs()
returns void as $$
begin
  update proofs
  set status = 'dormant'
  where status = 'in_progress'
    and last_activity_at < now() - interval '30 days';
end;
$$ language plpgsql;

-- Schedule: daily at 02:00 UTC
select cron.schedule('mark-dormant-proofs', '0 2 * * *', $$select mark_dormant_proofs()$$);
