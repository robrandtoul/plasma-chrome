-- Migration 000096: rebuild public_proof_versions for the
-- display_quantities + quote-bounds model
--
-- Swaps the two old quantity columns (featured_quantities,
-- expanded_quantities — dropped in 000095) for the three new
-- columns (display_quantities, quote_min_quantity,
-- quote_max_quantity). Every other column preserved verbatim
-- from the 000094 projection.
--
-- Must run immediately after 000095 — between the two
-- migrations the view does not exist and the customer page
-- cannot render. Both land in one `supabase db push` batch
-- so the window is momentary.

begin;

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
    pv.card_type,
    m.display_quantities,
    m.quote_min_quantity,
    m.quote_max_quantity
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
