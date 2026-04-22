-- Migration 000082: proof_versions.cloned_from_version_id
--
-- Adds an explicit pointer from a newly-created version to the
-- version it was cloned from. Used by the carry-forward feature in
-- NewVersionPage to record which v1 a v2 came from, so:
--
--   * approval carry-forward reads v1's approvals from the pointer,
--     not from "previous by created_at" (which breaks under any
--     future flow that creates concurrent drafts)
--   * future analytics / audit can reason about clone lineage as a
--     concrete fact, not an inferred neighbour
--
-- Nullable — v1 creation, manual admin inserts, and any historical
-- version all leave this null. ON DELETE SET NULL so deleting the
-- parent doesn't cascade to the child; the clone lineage becomes
-- detached (accurate — the parent is gone) but the child stays.

begin;

alter table proof_versions
  add column cloned_from_version_id uuid null
    references proof_versions(id) on delete set null;

comment on column proof_versions.cloned_from_version_id is
  'When this version was created via the New version form on an '
  'existing project, points to the project''s is_current version '
  'at the time of creation. Null for v1, admin-inserted rows, and '
  'all pre-migration rows.';

commit;
