-- Migration 000016: global and material-level disclaimers
--
-- Adds a singleton site_settings table for global config (global_disclaimer
-- is the first field), and a disclaimer column on materials for per-material
-- copy shown to customers alongside pricing.
--
-- Both are nullable; null/empty means the customer page renders nothing.

begin;

-- ── 1. site_settings ─────────────────────────────────────────────────────────

create table site_settings (
  id               int  primary key default 1,
  global_disclaimer text,
  constraint site_settings_singleton check (id = 1)
);

-- Seed with placeholder lorem ipsum (two paragraphs, ~80 words)
insert into site_settings (id, global_disclaimer) values (
  1,
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
);

-- ── 2. RLS on site_settings ───────────────────────────────────────────────────

alter table site_settings enable row level security;

create policy "site_settings: public read"
  on site_settings for select
  using (true);

create policy "site_settings: authenticated update"
  on site_settings for update
  to authenticated
  using (true);

-- ── 3. Public view for site_settings ─────────────────────────────────────────

create view public_site_settings as
  select global_disclaimer
  from site_settings
  where id = 1;

grant select on public_site_settings to anon, authenticated;

-- ── 4. Material-level disclaimer ──────────────────────────────────────────────

alter table materials
  add column disclaimer text;

-- Seed a different lorem ipsum block on two materials so the two blocks
-- are visually distinct during testing.
update materials
  set disclaimer =
    'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt neque porro quisquam est qui dolorem ipsum quia dolor sit amet.'
  where code in ('metal_steel', 'paper_letterpress');

-- ── 5. Expose material disclaimer through public_proof_versions ───────────────
--
-- Drop and recreate is safe because this is a view, not a table.
-- The view already joins materials via material_id, so we just add the column.

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
    m.featured_quantities,
    m.disclaimer as material_disclaimer
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
