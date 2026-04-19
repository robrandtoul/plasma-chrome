-- Migration 000024: per-ink name requirement flag on materials
--
-- For translucent/tinted/satin plastic and letterpress, the designer must
-- name each ink individually (one labelled field per ink). For every other
-- material, ink names stay optional and comma-separated.
--
-- The ink_names column on proof_versions is already text[] (see 000010 /
-- 000011), so no storage migration is required.

begin;

alter table materials
  add column requires_ink_names boolean not null default false;

update materials
  set requires_ink_names = true
  where code in (
    'plastic_translucent',
    'plastic_tinted',
    'plastic_satin',
    'paper_letterpress'
  );

commit;
