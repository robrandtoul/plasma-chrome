-- 000272: priority on the staff feedback board.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Follow-up to 000271. Adds a priority on each feedback item. The submitter
-- suggests one when posting (the insert RLS already lets them set any column on
-- their own row); only an admin can change it afterwards, via the same
-- admin-only UPDATE policy that gates status (so no extra policy is needed).
-- Default 'medium' so any rows created before this migration get a sensible
-- value. Additive column on an existing table — grants already cover it.

alter table proofs.feedback_items
  add column if not exists priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high'));
