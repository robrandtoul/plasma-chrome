-- Migration 000087: expose per-name approvals on public_proof_versions
--
-- Customer-side carry-forward flows produce a middle state where
-- some slots are approved from v(N-1) and others are awaiting the
-- customer's first review on the current version. Until now the
-- customer page only knew "this version is fully approved" (via
-- proofs.status='approved') or not — there was no way to signal
-- that Alice's slot is already approved while Bob's is still
-- open. This migration extends public_proof_versions with a
-- jsonb aggregate of every approval row for the version, keyed
-- on the slot name (real recipient name or the __shared__
-- sentinel), plus carry provenance so the customer page can
-- render "Approved from v{n}" where appropriate.
--
-- Only state + carried_from_version_id are exposed. The actor
-- identity fields (actor_name / actor_ip / actor_ua) are
-- deliberately kept off the view — they're a designer-only
-- audit concern and would leak who approved what to anyone
-- holding the public proof URL.
--
-- coalesce(..., '[]') normalises the empty-approvals case so the
-- client always sees an array, never null. No extra RLS gate —
-- the view's grant to anon + authenticated is the existing
-- access boundary, same as every other public_* view in this
-- repo.
--
-- Preserves the select list from migration 000070 (the last
-- recreation) and the materials join. card_type is deliberately
-- still NOT included (matches migration 000086's stance — the
-- column is designer-only; customer UI doesn't distinguish).

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
    ) as approvals
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
