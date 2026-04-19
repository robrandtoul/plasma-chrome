-- Migration 000023: custom quote flag on proof versions
--
-- When a proof is sufficiently bespoke that standard tier pricing doesn't
-- apply, the designer can flag the version as a custom quote. The customer
-- page hides the pricing grid and shows a short "quote separately" message.
-- The pricing snapshot is still captured, so toggling the flag off later
-- restores the original prices without re-saving.

begin;

alter table proof_versions
  add column custom_quote boolean not null default false;

-- Append to public_proof_versions. Columns before custom_quote stay in their
-- existing positions, so create or replace is safe here.
create or replace view public_proof_versions as
  select
    pv.id,
    pv.proof_id,
    pv.version_number,
    pv.material_id,
    pv.material_display,
    pv.ink_names,
    pv.currency,
    pv.pricing_snapshot,
    pv.shipping_note,
    pv.change_notes,
    pv.is_current,
    pv.created_at,
    pv.finishes,
    m.featured_quantities,
    m.disclaimer as material_disclaimer,
    pv.custom_quote
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
