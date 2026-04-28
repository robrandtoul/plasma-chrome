-- Migration 000125: surface proof_name_approvals.material_option_code
-- on public_proof_versions.approvals.
--
-- Migration 000124 added the column to proof_name_approvals; this
-- migration extends the public_proof_versions.approvals jsonb
-- projection to include it, so any future read surface (dashboards,
-- exports, the customer page itself if a "approved (brushed)"
-- pill ever lands) can see the per-recipient option code without
-- needing another schema-change migration.
--
-- Scope deliberately narrow: only the `approvals` projection. The
-- `latest_events_by_name` projection (000121) sources from
-- proof_events.material_option_code and could be extended too, but
-- nothing currently consumes it for option-level rendering. Out of
-- scope for this PR; trivial to add when a consumer needs it.
--
-- View rebuild pattern matches 000121 — drop + create rather than
-- create or replace, because the latter rejects column-set changes
-- on the underlying jsonb_build_object even though the top-level
-- view shape is identical. Granted to anon + authenticated, same
-- as the previous definition.

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
          'carried_from_version_id', pna.carried_from_version_id,
          'material_option_code', pna.material_option_code
        )),
        '[]'::jsonb
      )
      from proof_name_approvals pna
      where pna.proof_version_id = pv.id
    ) as approvals,
    pv.card_type,
    m.display_quantities,
    m.quote_min_quantity,
    m.quote_max_quantity,
    m.key_features,
    pv.displayed_variant_ids,
    -- Per-recipient latest events for this version (000121). Not
    -- extended in this migration; see header comment.
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', e.name,
          'event_type', e.event_type,
          'actor_name', e.actor_name,
          'comment', e.comment,
          'created_at', e.created_at,
          'helpscout_thread_id', e.helpscout_thread_id
        )),
        '[]'::jsonb
      )
      from (
        select distinct on (proof_version_id, name) *
        from proof_events
        where proof_version_id = pv.id
        order by proof_version_id, name, created_at desc
      ) e
    ) as latest_events_by_name,
    s.approvals_enabled as approvals_enabled
  from proof_versions pv
  join materials m on m.id = pv.material_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

commit;
