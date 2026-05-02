-- Rollback SQL for migrations 000116–000122 (Phase 2 / 2.5 multi-recipient
-- approval flow). Drafted 2026-04-27, to be executed only if the live
-- migration sequence fails or post-deploy smoke tests reveal an issue
-- requiring a full revert.
--
-- ── Order of operations ────────────────────────────────────────────────
--
-- Roll back in REVERSE order (122 → 116) so each rollback step undoes
-- a state that exists at that point in the apply sequence. Rolling
-- forward (116 first) would try to drop objects that downstream
-- migrations depend on.
--
-- ── Important note on 000119 ───────────────────────────────────────────
--
-- 000119 dropped two columns (total_price_at_action numeric, currency_at
-- _action text) from proof_events and added pricing_snapshot_at_action
-- jsonb in their place. The rollback recreates the two dropped columns
-- per the original 000116 commentary so anything that referenced them
-- pre-rollback compiles. Their values cannot be recovered from
-- pricing_snapshot_at_action (different shape) — if any rows were
-- inserted between 000119 applying and the rollback running, those
-- rows will get NULL for the recreated columns. proof_events was
-- documented as empty on prod at apply time; if that's still true, no
-- data is lost.
--
-- ── Important note on 000117 ───────────────────────────────────────────
--
-- 000117 made proof_versions.pricing_snapshot nullable. The rollback
-- below restores NOT NULL but ONLY if every row has a non-null value.
-- If NewVersionPage inserted any rows after the WIP code deploy
-- (writing displayed_variant_ids but not pricing_snapshot), the
-- ALTER will fail. In that case, either backfill those rows
-- manually or leave pricing_snapshot nullable and rely on the
-- code rollback to restore the writer.
--
-- ── How to use ─────────────────────────────────────────────────────────
--
-- Each section is a self-contained idempotent block. Run from
-- top to bottom. Inspect after each section before running the next
-- if there's any uncertainty about state.
--
-- Recommended execution path:
--   psql "<connection string>" -f merge-rollback.sql
-- or paste each section into the Supabase SQL editor sequentially.

begin;

-- ═══════════════════════════════════════════════════════════════════
-- 000122 rollback — drop dashboard_latest_events view
-- ═══════════════════════════════════════════════════════════════════

drop view if exists dashboard_latest_events;


-- ═══════════════════════════════════════════════════════════════════
-- 000121 rollback — restore the 000120 shape of public_proof_versions
-- and remove proof_events.name + its index
-- ═══════════════════════════════════════════════════════════════════

drop index if exists proof_events_version_name_created_at_idx;

alter table proof_events
  drop column if exists name;

drop view if exists public_proof_versions;

-- Restore the 000120 shape (5 flat latest_event_* columns + cross-join
-- of approvals_enabled). Note: this references latest_event_* fields
-- which were only valid in 000120; we'll drop this view again in the
-- 000120 rollback below.
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
    pe.event_type           as latest_event_type,
    pe.actor_name           as latest_event_actor_name,
    pe.comment              as latest_event_comment,
    pe.created_at           as latest_event_created_at,
    pe.helpscout_thread_id  as latest_event_helpscout_thread_id,
    s.approvals_enabled     as approvals_enabled
  from proof_versions pv
  join materials m on m.id = pv.material_id
  left join lateral (
    select event_type, actor_name, comment, created_at, helpscout_thread_id
    from proof_events e
    where e.proof_version_id = pv.id
    order by e.created_at desc
    limit 1
  ) pe on true
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- 000120 rollback — restore the 000118 shape of public_proof_versions
-- and the pre-000120 public_settings() RPC
-- ═══════════════════════════════════════════════════════════════════

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
    pv.displayed_variant_ids
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

-- Restore the pre-000120 public_settings() function (without the two
-- confirmation-copy fields). Inferred from migration 000120's CREATE
-- OR REPLACE — the prior shape returned the three customer-facing
-- fields disclaimer_text, company_name, reply_email.
create or replace function public_settings()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'disclaimer_text', disclaimer_text,
    'company_name',    company_name,
    'reply_email',     reply_email
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- 000119 rollback — restore total_price_at_action / currency_at_action
-- and drop pricing_snapshot_at_action
-- ═══════════════════════════════════════════════════════════════════

alter table proof_events
  drop column if exists pricing_snapshot_at_action;

alter table proof_events
  add column if not exists total_price_at_action numeric;

alter table proof_events
  add column if not exists currency_at_action text;


-- ═══════════════════════════════════════════════════════════════════
-- 000118 rollback — restore the 000117 shape of public_proof_versions
-- (no displayed_variant_ids column) and drop the column from the
-- underlying table
-- ═══════════════════════════════════════════════════════════════════

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
    m.key_features
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

alter table proof_versions
  drop column if exists displayed_variant_ids;


-- ═══════════════════════════════════════════════════════════════════
-- 000117 rollback — drop public_price_tiers + public_material_variants;
-- restore NOT NULL on proof_versions.pricing_snapshot
-- ═══════════════════════════════════════════════════════════════════

drop view if exists public_price_tiers;
drop view if exists public_material_variants;

-- Restore NOT NULL only if no rows have been inserted with a null
-- pricing_snapshot since 000117 applied. If WIP code deployed before
-- this rollback, NewVersionPage may have inserted rows with null
-- pricing_snapshot. The ALTER will fail in that case; back out by
-- backfilling those rows from displayed_variant_ids → live tier
-- lookup, OR leave pricing_snapshot nullable (rolling back code is
-- a softer revert).
alter table proof_versions
  alter column pricing_snapshot set not null;


-- ═══════════════════════════════════════════════════════════════════
-- 000116 rollback — drop proof_events table + the three settings
-- columns
-- ═══════════════════════════════════════════════════════════════════

drop policy if exists "proof_events: authenticated read" on proof_events;
drop index if exists proof_events_proof_version_id_created_at_idx;
drop index if exists proof_events_proof_version_id_idx;
drop table if exists proof_events;

alter table settings drop column if exists request_changes_confirmation_copy;
alter table settings drop column if exists approve_confirmation_copy;
alter table settings drop column if exists approvals_enabled;

commit;

-- ═══════════════════════════════════════════════════════════════════
-- Post-rollback verification queries
-- ═══════════════════════════════════════════════════════════════════
--
-- Run these to confirm the rollback completed cleanly:
--
--   select column_name from information_schema.columns
--   where table_name = 'settings'
--     and column_name in ('approvals_enabled', 'approve_confirmation_copy', 'request_changes_confirmation_copy');
--   -- Expected: 0 rows
--
--   select count(*) from information_schema.tables where table_name = 'proof_events';
--   -- Expected: 0
--
--   select column_name from information_schema.columns
--   where table_name = 'proof_versions' and column_name = 'displayed_variant_ids';
--   -- Expected: 0 rows
--
--   select count(*) from information_schema.views
--   where table_name in ('public_price_tiers','public_material_variants','dashboard_latest_events');
--   -- Expected: 0
--
--   select is_nullable from information_schema.columns
--   where table_name = 'proof_versions' and column_name = 'pricing_snapshot';
--   -- Expected: 'NO'
