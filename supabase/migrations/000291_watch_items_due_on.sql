-- 000291: optional expected-resolution date on flagged projects.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration. Do NOT use `supabase db push`.
--
-- Adds a nullable target date staff can set on a watch_items card ("expect this
-- resolved by"). User-set (not derived), so no trigger; the existing all-staff
-- UPDATE policy + grants from 000290 already cover the new column.

alter table proofs.watch_items add column due_on date;

comment on column proofs.watch_items.due_on is
  'Optional expected-resolution / target date set by staff on a flagged card.';
