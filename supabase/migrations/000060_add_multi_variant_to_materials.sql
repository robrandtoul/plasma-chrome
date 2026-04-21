-- Migration 000060: explicit multi_variant flag on materials
--
-- Until now the Add version form decided whether a material exposes
-- multiple variants on a single proof by checking variant_type =
-- 'thickness' at runtime. That baked a specific material-axis value
-- into the frontend. Promoting it to a dedicated boolean on materials
-- means the rule lives in data, not code, and a new material that
-- behaves the same way can opt in without touching the client.
--
-- Rule: true when every variant for the material has variant_type =
-- 'thickness'. Today that matches every thickness material; no other
-- axis is multi-variant. Backfill is explicit via a subquery rather
-- than relying on the old check staying in sync.

begin;

alter table materials
  add column multi_variant boolean not null default false;

update materials
  set multi_variant = true
  where id in (
    select distinct mv.material_id
    from material_variants mv
    where mv.variant_type = 'thickness'
      and mv.is_active = true
  );

commit;
