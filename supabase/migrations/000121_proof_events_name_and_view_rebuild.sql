-- Migration 000121: per-recipient dimension on proof_events.
--
-- Phase 2.5 reshapes the customer Approve / Request changes flow
-- from per-version to per-recipient. The investigation report for
-- this prompt confirmed the carry-forward signal is fully
-- derivable from the existing image_path equality + the existing
-- proof_name_approvals.carried_from_version_id provenance pointer
-- (migration 000083), so this migration does NOT add any carry-
-- forward column. It just adds the name dimension to proof_events
-- and reshapes the customer page's read of "latest event(s) for
-- this version" from a flat per-version field set into a per-
-- recipient JSONB array on public_proof_versions.
--
-- ── Part A: proof_events.name ────────────────────────────────────
--
-- Nullable. NULL = "whole-version" event for proofs with no named
-- recipients (membership / single-design). Multi-recipient proofs
-- carry the recipient name (matching pv.names) or the
-- SHARED_APPROVAL_KEY sentinel '__shared__' for the shared
-- section. Edge function (Prompt 2) validates against
-- pv.names ∪ {'__shared__'} at action time. No FK / no CHECK at
-- the DB level — same plain-text convention as
-- proof_name_approvals.name (000076) and
-- proof_version_images.associated_name (000071).
--
-- No UNIQUE on (proof_version_id, name) — proof_events stays
-- append-only by design (Phase 2 Prompt 1 rationale: a customer
-- who requests changes on v(N), then later approves on the same
-- v(N), generates two events; the history is meaningful and
-- shouldn't be clobbered by an upsert).
--
-- Index on (proof_version_id, name, created_at DESC) backs the
-- "latest event per (version, name)" lookup the rebuilt view
-- relies on. The existing proof_events_proof_version_id_idx
-- (000116) and proof_events_proof_version_id_created_at_idx
-- (000116) stay — no overlap with the new index since they don't
-- include name.
--
-- Backfill: none. proof_events has zero rows on prod (Phase 2
-- verification reset cleared all test events).
--
-- ── Part B: public_proof_versions rebuild ────────────────────────
--
-- The five flat latest_event_* fields added by 000120 don't make
-- sense once events are per-recipient. Replace them with a single
-- latest_events_by_name JSONB array — one entry per
-- (proof_version_id, name) pair, latest event per pair (DISTINCT
-- ON … ORDER BY created_at DESC). Empty array when no events
-- exist for the version, so the customer page can iterate
-- without a null check.
--
-- DROP + CREATE rather than CREATE OR REPLACE because removing
-- columns is not allowed by REPLACE — only column-list extension
-- at the end. The view's other columns are preserved verbatim
-- from the 000120 shape.
--
-- The existing approvals JSONB column (000087, jsonb_agg over
-- proof_name_approvals) is left untouched. That's the designer-
-- facing state surface and continues to drive the muted "Approved
-- from v(N-1)" pills on the customer page; the new
-- latest_events_by_name array is the per-version event-stream
-- the customer-action UI keys on.

begin;

-- ── Part A ───────────────────────────────────────────────────────

alter table proof_events
  add column if not exists name text;

comment on column proof_events.name is
  'Recipient this event applies to. NULL = "whole-version" event '
  '(membership / single-design proofs). For multi-recipient '
  'proofs, the edge function validates name against pv.names ∪ '
  '{''__shared__''} at action time. Plain text, no FK — matches '
  'proof_name_approvals.name (000076) and '
  'proof_version_images.associated_name (000071) conventions. '
  'No UNIQUE on (proof_version_id, name); proof_events is '
  'append-only and the latest-per-pair lookup happens at read '
  'time via public_proof_versions.latest_events_by_name.';

create index if not exists proof_events_version_name_created_at_idx
  on proof_events (proof_version_id, name, created_at desc);

-- ── Part B ───────────────────────────────────────────────────────

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
    -- Phase 2.5: per-recipient latest events for this version.
    -- One entry per (proof_version_id, name) pair, latest per
    -- pair via DISTINCT ON. NULL name is allowed and treated
    -- as its own group (whole-version events). Empty array
    -- when no events exist; never null.
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
