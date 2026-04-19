-- Migration 000013: expose featured_quantities on public_proof_versions
--
-- The customer page needs featured_quantities to filter the default rows shown.
-- Rather than opening the materials table to anonymous reads, we join it into
-- the view here. The view runs with its owner's permissions (bypassing RLS),
-- so anonymous callers get the column without needing direct table access.

create or replace view public_proof_versions as
  select
    pv.id,
    pv.proof_id,
    pv.version_number,
    pv.image_path,
    pv.material_id,
    pv.material_display,
    pv.ink_names,
    pv.currency,
    pv.pricing_snapshot,
    pv.shipping_note,
    pv.change_notes,
    pv.is_current,
    pv.created_at,
    m.featured_quantities
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;
