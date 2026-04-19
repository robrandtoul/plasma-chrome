-- Migration 000021: original filename on proof_version_images
--
-- Stores the uploader's filename (e.g. "jb-marine-front.jpg") alongside the
-- storage path. Shown on the designer and customer pages so both sides can
-- reference images by the same name.
--
-- Nullable: pre-existing rows stay null; UI hides the filename when null.

begin;

alter table proof_version_images
  add column original_filename text;

-- Recreate public view to expose the new column.

drop view if exists public_proof_version_images;

create view public_proof_version_images as
  select id, proof_version_id, image_path, label, sort_order, finish, original_filename
  from proof_version_images;

grant select on public_proof_version_images to anon, authenticated;

commit;
