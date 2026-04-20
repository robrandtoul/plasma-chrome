-- Migration 000047: per-material description + icon
--
-- Two new nullable columns on materials for the customer-facing
-- "About [Material]" block:
--   description   — paragraph text shown in the left column
--   icon_url      — public URL of the icon image shown in the right column
--
-- Plus a new public storage bucket (material-icons) so the icons are
-- reachable without auth on the customer page. Admin-only writes.
-- public_proof_versions grows two columns so the customer page can pull
-- everything it needs in the existing single read.
--
-- The older `disclaimer` column stays in place — it's superseded by
-- `description` but kept for backward compatibility in case any other
-- tooling reads it.

begin;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

alter table materials
  add column description text,
  add column icon_url    text;

-- ── 2. Storage bucket ────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'material-icons',
  'material-icons',
  true,
  2097152,                                        -- 2 MB per icon
  array['image/png', 'image/jpeg', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Public read happens via the bucket's public flag + the standard
-- storage public URL; no RLS read policy needed for that. Admin writes
-- still go through RLS.
create policy "material-icons: admin upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'material-icons' and is_admin());

create policy "material-icons: admin update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'material-icons' and is_admin());

create policy "material-icons: admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'material-icons' and is_admin());

-- ── 3. Extend public_proof_versions view ────────────────────────────────────

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
    pv.custom_quote
  from proof_versions pv
  join materials m on m.id = pv.material_id;
grant select on public_proof_versions to anon, authenticated;

commit;
