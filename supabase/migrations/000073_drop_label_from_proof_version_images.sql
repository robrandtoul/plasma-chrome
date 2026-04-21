-- Migration 000073: drop legacy label column from proof_version_images
--
-- The label column predates the image-to-name feature. It carried
-- designer-supplied captions like "Front" / "Back" / "Image 3".
-- Migration 000071 introduced associated_name + side, and the
-- customer page derives its caption from side + original_filename.
-- The designer-facing label input was removed earlier. At this
-- point the column stores either stale legacy values on historical
-- rows or empty strings on new rows, and nothing reads it on the
-- customer page.
--
-- public_proof_version_images references label, so it has to be
-- dropped + recreated in the same transaction. No customer-facing
-- regression expected — the view's consumer (CustomerProofPage)
-- rewrites `label` client-side from side / filename before it
-- reaches ImageGrid's Caption.
--
-- No data-salvage step. If we ever want to mine the old captions
-- for research, they're still in proof_version_images before this
-- migration runs, and downstream backups hold them indefinitely.

begin;

-- 1. Drop the dependent view first so PG doesn't block the column
--    drop. We rebuild it at the end without the column.
drop view if exists public_proof_version_images;

-- 2. Drop the column.
alter table proof_version_images drop column label;

-- 3. Recreate the view with the same column set minus label.
create view public_proof_version_images as
  select
    id,
    proof_version_id,
    image_path,
    sort_order,
    material_option,
    original_filename,
    associated_name,
    side
  from proof_version_images;
grant select on public_proof_version_images to anon, authenticated;

commit;
