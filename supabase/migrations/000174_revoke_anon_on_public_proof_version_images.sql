-- Migration 000174: remediate anon leak on public_proof_version_images.
--
-- Migration 000168 dropped and recreated public_proof_version_images to
-- expose the new QR columns (is_qr_code, qr_decoded_data, qr_kind) but
-- did NOT carry forward the `revoke select … from anon, public` that
-- 000162 had originally installed. Dropping and recreating a view in
-- PostgreSQL resets its grants; any privileges that need to stay
-- revoked must be re-asserted after the create.
--
-- The result was that between 000168 and this migration, anon SELECT
-- on public_proof_version_images was effectively re-enabled by the
-- default schema-wide GRANT that Supabase carries on every new view.
-- This re-applies the revoke to close the leak.
--
-- Already applied directly to live; captured into source as a
-- reconcile so the source-vs-live migration chain stays consistent
-- (same pattern as 000146). The REVOKE is idempotent — re-running it
-- on a database where the grant is already absent is a no-op.

begin;

revoke select on public_proof_version_images from anon, public;

commit;
