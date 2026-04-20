-- Migration 000027: track which designer created each proof version
--
-- Adds a nullable created_by column on proof_versions that defaults to the
-- authenticated user who performed the insert. This powers the "Recent
-- projects" card on the designer dashboard so each designer sees the
-- projects they have actually worked on.
--
-- The column is intentionally nullable and has no backfill — historical
-- rows simply stay null and won't appear in any designer's recent list,
-- which is acceptable for this feature.
--
-- on delete set null: if a designer account is removed later, the version
-- history stays intact; the row just loses its attribution.

begin;

alter table proof_versions
  add column created_by uuid
    references auth.users(id) on delete set null
    default auth.uid();

commit;
