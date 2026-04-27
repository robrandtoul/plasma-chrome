-- Migration 000120: customer-facing read of approval state + the
-- approvals_enabled flag, exposed via public_proof_versions.
--
-- Phase 2 Prompt 7 wires the customer page's Approve / Request
-- changes UI to the proof_events table written by the proof-action
-- edge function (000119). The customer page is anon, and both
-- proof_events and settings are RLS-locked away from anon by design
-- (proof_events to prevent forgery, settings to prevent leaking
-- designer-only defaults). Rather than carve a new anon-readable
-- surface for each, we extend the already-anon-readable
-- public_proof_versions view to carry a denormalised read of:
--
--   * The most recent proof_events row for this version, via a
--     LATERAL subquery that LIMIT 1's by created_at DESC. This
--     drives the customer-page "you've already approved this" /
--     "you requested changes" lockout banner. Five fields:
--       latest_event_type, latest_event_actor_name,
--       latest_event_comment, latest_event_created_at,
--       latest_event_helpscout_thread_id.
--
--   * settings.approvals_enabled, joined as a CROSS JOIN against
--     the singleton settings row. Same value on every output row —
--     tolerable redundancy in exchange for not having to extend
--     public_settings() or open a new RLS path. The customer page
--     reads this once per page load via the proof_versions fetch
--     it already does.
--
-- The two confirmation-copy strings (approve_confirmation_copy,
-- request_changes_confirmation_copy) are NOT on the view — they're
-- per-page config, not per-version, so denormalising them per-row
-- would be wasteful. They go on the public_settings() RPC instead,
-- alongside disclaimer_text and the other customer-visible singleton
-- fields. That update follows in this same migration.
--
-- CREATE OR REPLACE VIEW with all-existing-columns + new ones
-- appended. PostgreSQL allows column-list extension at the end
-- without a drop+create as long as no existing column is renamed
-- or has its type changed. Idempotent.

begin;

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
    m.quote_max_quantity,
    m.key_features,
    pv.displayed_variant_ids,
    -- Phase 2 customer approval flow (000116, 000119, 000120) ──────────────
    pe.event_type           as latest_event_type,
    pe.actor_name           as latest_event_actor_name,
    pe.comment              as latest_event_comment,
    pe.created_at           as latest_event_created_at,
    pe.helpscout_thread_id  as latest_event_helpscout_thread_id,
    s.approvals_enabled     as approvals_enabled
  from proof_versions pv
  join materials m on m.id = pv.material_id
  -- LATERAL pulls the chronologically-newest proof_events row per
  -- version. NULL when no event has been recorded — drives the
  -- customer page's button-vs-banner branching.
  left join lateral (
    select event_type, actor_name, comment, created_at, helpscout_thread_id
    from proof_events e
    where e.proof_version_id = pv.id
    order by e.created_at desc
    limit 1
  ) pe on true
  -- Singleton settings row joined unconditionally. Same boolean on
  -- every row, but it lets anon read the flag without a new RLS
  -- path on settings.
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

-- ── public_settings(): add the two confirmation-copy fields ──────────────
--
-- The customer page's Approve / Request changes confirmation modal
-- needs the editable copy strings (000116). They're customer-visible,
-- so the public_settings() RPC is the right home — same surface as
-- disclaimer_text. SECURITY DEFINER means anon can call without
-- needing settings-table grants.

create or replace function public_settings()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'disclaimer_text',                    disclaimer_text,
    'company_name',                       company_name,
    'reply_email',                        reply_email,
    'approve_confirmation_copy',          approve_confirmation_copy,
    'request_changes_confirmation_copy',  request_changes_confirmation_copy
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;

commit;
