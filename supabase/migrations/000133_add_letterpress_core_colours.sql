-- Migration 000133: letterpress core colours.
--
-- Letterpress cards produced WITHOUT edge gilding expose their three-
-- layer construction at the edge. We commonly accent the middle
-- (core) layer with a chosen colour. This is a no-cost selection
-- but it's a feature customers value, so we surface it on the
-- customer proof page's Specification section.
--
-- Two materials in the catalogue split the gilded/un-gilded
-- distinction (paper_letterpress = no gilding, paper_letterpress_gilded
-- = with gilding), so on the designer form the core-colour picker
-- only renders for paper_letterpress.
--
-- Soft-delete pattern: the admin page deactivates rows by flipping
-- is_active=false rather than DELETE, so existing proof_versions
-- referencing the colour stay intact (FK on delete restrict). Public
-- select policy filters to is_active=true so designers don't see
-- retired colours in the picker; admin policy reads everything.
--
-- The id was named 000067 in the original spec, but that slot is
-- already occupied by 000067_helpscout_link_or_override_required.
-- This migration takes 000133 (next available after 000132).

begin;

-- ── 1. Catalogue table ───────────────────────────────────────────────────────

create table letterpress_core_colours (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  hex_value   text        not null check (hex_value ~ '^#[0-9A-Fa-f]{6}$'),
  is_active   boolean     not null default true,
  sort_order  int         not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index letterpress_core_colours_active_sort_idx
  on letterpress_core_colours (is_active, sort_order, name);

-- Bump updated_at on every UPDATE. Mirrors the trigger pattern used
-- elsewhere in the schema (e.g. proof_name_approvals) so before/after
-- diffs in audit_log line up with the timestamp.
create or replace function set_letterpress_core_colour_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger letterpress_core_colours_set_updated_at
  before update on letterpress_core_colours
  for each row execute function set_letterpress_core_colour_updated_at();

-- ── 2. Starter palette ───────────────────────────────────────────────────────
-- Sort order spaced 10 apart so future inserts can slot in between
-- without renumbering. Hex values lowercase-normalised (the CHECK
-- accepts either case).

insert into letterpress_core_colours (name, hex_value, sort_order) values
  ('Natural',  '#f5efe0', 10),
  ('Black',    '#1a1a1a', 20),
  ('Burgundy', '#5c1a1b', 30),
  ('Sapphire', '#1b3a6b', 40),
  ('Sage',     '#7a8a6b', 50),
  ('Charcoal', '#3a3a3a', 60),
  ('Mustard',  '#c99a3b', 70),
  ('Copper',   '#a65a2a', 80);

-- ── 3. FK from proof_versions ────────────────────────────────────────────────
-- Nullable because every non-letterpress proof_version row will have
-- this null, plus historical letterpress rows pre-dating this
-- migration. on delete restrict guarantees the soft-delete admin
-- flow can never silently drop a colour that's still referenced.

alter table proof_versions
  add column core_colour_id uuid
    references letterpress_core_colours(id) on delete restrict;

create index proof_versions_core_colour_id_idx
  on proof_versions (core_colour_id);

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
-- Belt-and-braces: REVOKE all from anon + public so direct table
-- reads aren't possible even if a future policy widening is wrong.
-- Customer-facing reads MUST go through the public_proof_versions
-- view (re-granted to anon below).

alter table letterpress_core_colours enable row level security;

revoke all on letterpress_core_colours from anon, public;

-- Authenticated reads — designers see only the active palette via
-- their normal queries. Admins read everything via the admin policy.
create policy "letterpress_core_colours: authenticated read active"
  on letterpress_core_colours for select to authenticated
  using (is_active = true);

create policy "letterpress_core_colours: admin read all"
  on letterpress_core_colours for select to authenticated
  using (is_admin());

create policy "letterpress_core_colours: admin insert"
  on letterpress_core_colours for insert to authenticated
  with check (is_admin());

create policy "letterpress_core_colours: admin update"
  on letterpress_core_colours for update to authenticated
  using (is_admin());

create policy "letterpress_core_colours: admin delete"
  on letterpress_core_colours for delete to authenticated
  using (is_admin());

-- ── 5. public_proof_versions view rebuild ────────────────────────────────────
-- View shape changes (adding two columns from a left join) require
-- drop + create; CREATE OR REPLACE rejects column-set changes. Mirrors
-- migration 000125's pattern. Re-grant select to anon + authenticated
-- so the customer page keeps reading.

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
    s.approvals_enabled as approvals_enabled,
    -- Letterpress core colour — left join so non-letterpress and
    -- pre-migration rows return null for both fields. Customer
    -- page renders the spec row only when both are non-null.
    cc.name             as core_colour_name,
    cc.hex_value        as core_colour_hex
  from proof_versions pv
  join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

grant select on public_proof_versions to anon, authenticated;

commit;
