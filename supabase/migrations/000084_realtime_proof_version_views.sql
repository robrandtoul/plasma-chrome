-- Migration 000084: publish proof_version_views on supabase_realtime
--
-- Designer-side ProofDetailPage subscribes to INSERTs on this
-- table so the customer-viewed indicator updates live without a
-- page refresh. Client-side filter drops is_bot=true rows before
-- touching state; see useLiveProofViews.
--
-- Idempotent — ALTER PUBLICATION ... ADD TABLE errors if the
-- table is already a member, so the DO block guard makes re-
-- running safe.

begin;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'proof_version_views'
  ) then
    alter publication supabase_realtime add table proof_version_views;
  end if;
end $$;

commit;
