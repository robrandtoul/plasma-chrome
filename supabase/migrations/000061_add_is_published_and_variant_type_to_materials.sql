-- Migration 000061: publish flag + lift variant_type up to materials
--
-- Two schema changes needed to support the admin "create material"
-- flow from Phase 3a, done together so the constraints line up.
--
-- is_published
--   Gates whether a material shows up in the designer-side Add version
--   dropdown. Every current material is in use so existing rows
--   backfill to true. New rows land unpublished so an admin can finish
--   configuring variants and prices before exposing the material.
--
-- variant_type
--   Historically lived on material_variants, but per CLAUDE.md every
--   variant of a material shares the same type, so it's effectively a
--   material-level property that was stored on the wrong table.
--   Lifting it up mirrors what we did with multi_variant in 000060 and
--   lets the future variant-creation UI read materials.variant_type
--   directly. Backfill pulls the value from the first active variant;
--   the coalesce handles materials with zero variants (shouldn't
--   happen today but belt-and-braces).

begin;

-- ── is_published ────────────────────────────────────────────────────────────

alter table materials
  add column is_published boolean not null default false;

update materials set is_published = true;

-- New rows land unpublished. Existing rows stay true from the update above.
alter table materials
  alter column is_published set default false;

-- ── variant_type ────────────────────────────────────────────────────────────

alter table materials
  add column variant_type text not null default 'default'
    check (variant_type in ('thickness', 'ink_count', 'finish', 'default'));

update materials m
  set variant_type = coalesce(
    (select mv.variant_type
       from material_variants mv
       where mv.material_id = m.id
       limit 1),
    'default'
  );

commit;
