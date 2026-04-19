-- Migration 000014: one-to-many images per proof version
--
-- Replaces the single image_path column on proof_versions with a separate
-- proof_version_images table. A version can now have 1–10 images, each with
-- a designer-supplied label and an explicit sort_order.

begin;

-- ── 1. New table ──────────────────────────────────────────────────────────────

create table proof_version_images (
  id               uuid primary key default gen_random_uuid(),
  proof_version_id uuid not null references proof_versions(id) on delete cascade,
  image_path       text not null,
  label            text not null,
  sort_order       int not null,
  created_at       timestamptz not null default now()
);

create index proof_version_images_version_order_idx
  on proof_version_images (proof_version_id, sort_order);

-- ── 2. Migrate existing single image_path values ──────────────────────────────

insert into proof_version_images (proof_version_id, image_path, label, sort_order)
select id, image_path, 'Front', 0
from proof_versions
where image_path is not null and image_path <> '';

-- ── 3. Remove image_path from proof_versions ──────────────────────────────────

-- Drop the view first; it references image_path and blocks the column drop.
drop view if exists public_proof_versions;

alter table proof_versions drop column image_path;

-- ── 4. RLS on proof_version_images ────────────────────────────────────────────

alter table proof_version_images enable row level security;

create policy "proof_version_images: public select"
  on proof_version_images for select using (true);

create policy "proof_version_images: authenticated insert"
  on proof_version_images for insert to authenticated with check (true);

create policy "proof_version_images: authenticated update"
  on proof_version_images for update to authenticated using (true);

create policy "proof_version_images: authenticated delete"
  on proof_version_images for delete to authenticated using (true);

-- ── 5. Public view ────────────────────────────────────────────────────────────

create view public_proof_version_images as
  select id, proof_version_id, image_path, label, sort_order
  from proof_version_images;

grant select on public_proof_version_images to anon, authenticated;

-- ── 6. Update public_proof_versions view (drop image_path column) ─────────────

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
    m.featured_quantities
  from proof_versions pv
  join materials m on m.id = pv.material_id;

grant select on public_proof_versions to anon, authenticated;

commit;
