-- Migration 000090: expose card_type on public_proof_versions
--
-- proof_versions.card_type was added in migration 000086 but
-- deliberately kept OFF the public view. The commit that
-- shipped the tiered-membership work (f70b551) put it this
-- way: "customer-facing UI doesn't need to distinguish —
-- card_type is a designer-only concept." That stance held
-- while the customer page rendered the same chrome for both
-- modes.
--
-- It no longer holds. The Proofs-section count subtext now
-- copy-switches between "N unique proofs · M people" (for
-- business cards) and hidden entirely (for membership cards),
-- which means the customer render path needs the field.
-- Adding it to the view here is the minimal change.
--
-- Non-sensitive — enum of two values, designer-set, same
-- exposure class as pv.material_display or pv.names already
-- projected. No PII or internal-workspace path leakage.
--
-- Preserves every column from 000087 verbatim, appending
-- pv.card_type at the end of the projection list. The
-- approvals jsonb_agg subquery stays identical.

begin;

drop view if exists public_proof_versions;

create view public_proof_versions as
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
    pv.material_options,
    m.featured_quantities,
    m.disclaimer        as material_disclaimer,
    m.description       as material_description,
    m.icon_url          as material_icon_url,
    m.option_label,
    pv.custom_quote,
    pv.superseded_at,
    pv.names,
    pv.split_name_surcharge_snapshot,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', pna.name,
          'state', pna.state,
          'carried_from_version_id', pna.carried_from_version_id
        )),
        '[]'::jsonb
      )
      from proof_name_approvals pna
      where pna.proof_version_id = pv.id
    ) as approvals,
    pv.card_type
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
