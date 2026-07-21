-- Migration 000335: allow PNG uploads to the proof-images bucket.
--
-- The artwork QR scanner (src/lib/qrArtworkScan.ts) offers the
-- designer a ready-made image of any QR code it finds in the
-- uploaded artwork. Both ways it produces that image are PNG:
-- the crop cut out of the artwork (canvas.toBlob 'image/png') and
-- the crisp rebuilt render (qrRebuild.ts, also 'image/png').
--
-- The proof-images bucket has been JPEG-only since migration
-- 000032 (plus image/svg+xml for generated hosted-vCard QRs since
-- 000193), so accepting a scanner suggestion made the version save
-- fail with "mime type image/png is not supported" — same failure
-- shape 000193 fixed for SVGs. This adds image/png to the list.
--
-- PNG is the right format for these images: lossless, so the
-- sharp module edges that make a rebuilt QR scannable off a
-- screen survive storage, and smaller than JPEG for flat
-- black-and-white content.
--
-- The 000032 rationale (artwork arrives as JPEG; keep one
-- consistent format, avoid PNG bloat) still holds in practice:
-- the artwork drop zones and the manual QR drop zone all enforce
-- JPEG client-side, so the only PNGs reaching the bucket are the
-- scanner's few-KB QR images.
--
-- Safe to allow: proof images render through <img> tags on both
-- the customer page and the designer forms; PNG has no script
-- execution surface.

begin;

update storage.buckets
  set allowed_mime_types = array['image/jpeg', 'image/svg+xml', 'image/png']
  where id = 'proof-images';

commit;
