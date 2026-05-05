-- Migration 000136: replace letterpress_core_colours with the
-- canonical 50-colour Colorplan list.
--
-- Source: letterpress-paper-swatches.xlsx (50 rows, 2026-05-05).
--
-- Strategy:
--   * Snapshot the previous active count for the audit_log entry
--     before any mutations.
--   * Pre-step rename: 'Ebony black' (#000000) → 'Ebony' (#261f1d).
--     Done before the upsert so the conflict target hits the same
--     row and its uuid is preserved. Any proof_versions row pointing
--     at the old 'Ebony black' uuid keeps resolving to the same
--     palette entry, which is now correctly named.
--   * Upsert by name (UNIQUE constraint on name from 000133): each
--     of the 50 canonical rows either updates an existing row in
--     place (preserving uuid and FK references) or inserts fresh.
--     Every upserted row ends with is_active = true regardless of
--     prior state — so anything previously deactivated and now
--     present in the canonical list comes back online.
--   * Soft-deactivate any currently-active row whose name isn't in
--     the canonical list. on delete restrict on proof_versions FKs
--     forbids hard delete; soft-deactivate keeps existing proofs
--     rendering while hiding the colour from the designer dropdown.
--   * One audit_log row recording the operation, with before / after
--     active counts and the source filename.
--
-- All inside a single transaction. If anything fails the whole
-- thing rolls back, including the rename pre-step.
--
-- Hex values stored lowercase to match the convention from 000134;
-- the CHECK regex ('^#[0-9A-Fa-f]{6}$') accepts both cases.
--
-- "Park Green" preserved with capital G as supplied; not auto-
-- corrected to sentence case.

begin;

-- ── 1. Snapshot before-state for the audit_log row ──────────────────────────

create temp table _audit_before on commit drop as
  select count(*) filter (where is_active) as previous_active_count
    from letterpress_core_colours;

-- ── 2. Canonical 50 staged in a temp table ──────────────────────────────────
-- Used by both the upsert (source rows) and the soft-deactivate
-- (membership check), so the canonical name list is declared once.

create temp table _canonical (
  name        text primary key,
  hex_value   text not null,
  sort_order  int  not null
) on commit drop;

insert into _canonical (name, hex_value, sort_order) values
  ('Adriatic',         '#4277a0',  10),
  ('Amethyst',         '#3d2e48',  20),
  ('Azure blue',       '#b5c5d7',  30),
  ('Bagdad brown',     '#4d3b33',  40),
  ('Bitter chocolate', '#3f3433',  50),
  ('Bright red',       '#ca323c',  60),
  ('Bright white',     '#fffef1',  70),
  ('Candy pink',       '#e8b8c2',  80),
  ('China white',      '#fcf4d6',  90),
  ('Citrine',          '#faa702', 100),
  ('Claret',           '#46262e', 110),
  ('Cobalt',           '#38455b', 120),
  ('Cool blue',        '#d1d0d8', 130),
  ('Cool grey',        '#eff1f2', 140),
  ('Dark grey',        '#5b5b59', 150),
  ('Ebony',            '#261f1d', 160),
  ('Emerald',          '#377a6b', 170),
  ('Factory yellow',   '#face05', 180),
  ('Forest',           '#375842', 190),
  ('Fuchsia pink',     '#cd5c9b', 200),
  ('Harvest',          '#b6977d', 210),
  ('Hot pink',         '#e34c73', 220),
  ('Imperial blue',    '#212d3d', 230),
  ('Lavender',         '#c1aad5', 240),
  ('Lockwood green',   '#377243', 250),
  ('Mandarin',         '#f16301', 260),
  ('Marrs green',      '#008c8c', 270),
  ('Mid green',        '#8b967b', 280),
  ('Mist',             '#f0e4c5', 290),
  ('Natural',          '#f2f0de', 300),
  ('New blue',         '#809cbd', 310),
  ('Pale grey',        '#d2d0cd', 320),
  ('Park Green',       '#a7d7b3', 330),
  ('Pistachio',        '#d0ddc1', 340),
  ('Powder green',     '#e2efdd', 350),
  ('Pristine white',   '#fffdf9', 360),
  ('Purple',           '#705299', 370),
  ('Racing green',     '#2e3e3d', 380),
  ('Real grey',        '#afafa6', 390),
  ('Rust',             '#c96846', 400),
  ('Sapphire',         '#2b466f', 410),
  ('Scarlet',          '#8d303c', 420),
  ('Slate',            '#454b4f', 430),
  ('Smoke',            '#676767', 440),
  ('Stone',            '#d8b9a7', 450),
  ('Tabriz blue',      '#1e9acd', 460),
  ('Turquoise',        '#68ccce', 470),
  ('Vellum white',     '#fffaef', 480),
  ('Vermilion',        '#ac2934', 490),
  ('White frost',      '#f6fbfd', 500);

-- ── 3. Rename pre-step: Ebony black → Ebony ─────────────────────────────────
-- Run before the upsert so the conflict target matches the renamed
-- row instead of inserting a duplicate. Hex changes from #000000 to
-- the canonical #261f1d. Any proof_versions row referencing this
-- uuid keeps working with no FK churn.

update letterpress_core_colours
   set name       = 'Ebony',
       hex_value  = '#261f1d',
       updated_at = now()
 where name = 'Ebony black';

-- ── 4. Upsert the canonical 50 ──────────────────────────────────────────────
-- ON CONFLICT (name) hits the UNIQUE constraint from 000133. Every
-- upserted row ends active regardless of prior state, so a name
-- that was previously soft-deactivated and now reappears in the
-- canonical list is reactivated rather than silently left inactive.

insert into letterpress_core_colours (name, hex_value, sort_order, is_active)
  select name, hex_value, sort_order, true from _canonical
  on conflict (name) do update
    set hex_value  = excluded.hex_value,
        sort_order = excluded.sort_order,
        is_active  = true,
        updated_at = now();

-- ── 5. Soft-deactivate anything not in the canonical list ───────────────────
-- Keeps the rows around so existing proof_versions FK references
-- continue to resolve. The active filter on the designer dropdown
-- (RLS policy "letterpress_core_colours: authenticated read active")
-- hides them from new picks.

update letterpress_core_colours
   set is_active  = false,
       updated_at = now()
 where is_active = true
   and name not in (select name from _canonical);

-- ── 6. Audit log entry ──────────────────────────────────────────────────────
-- Written directly rather than via log_audit_event() because the
-- RPC requires auth.uid() to be non-null, which doesn't hold in a
-- migration context. Service-role / superuser bypasses RLS so a
-- direct INSERT is safe here. actor_email/label use a 'system'
-- literal so the row is easy to filter for in the activity feed.

insert into audit_log (
  actor_email, actor_label,
  action,
  target_type, target_label,
  before_value, after_value
)
select
  'system@migration',
  'system',
  'core_colours_bulk_replace',
  'letterpress_core_colours_table',
  'letterpress_core_colours',
  jsonb_build_object('previous_active_count', _audit_before.previous_active_count),
  jsonb_build_object(
    'new_active_count', (select count(*) filter (where is_active) from letterpress_core_colours),
    'source_filename', 'letterpress-paper-swatches.xlsx'
  )
  from _audit_before;

commit;
