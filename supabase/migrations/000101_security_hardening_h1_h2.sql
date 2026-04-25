-- Migration 000101: security hardening — H1 + H2 from the audit
--
-- Two unrelated tightenings landing together because both are
-- one-line schema changes whose new behaviour depends on
-- corresponding application-side changes shipped alongside.
--
-- ── H1: anon storage path enumeration ──────────────────────────
-- The proof-images: anon signed url policy on storage.objects
-- (added in migration 20260419000008) granted anon SELECT on
-- the bucket so the customer page could call createSignedUrl.
-- Side effect: storage.from('proof-images').list('') returned
-- the entire object listing to anyone with the public anon
-- key. Combined with the same policy permitting signed-URL
-- creation against any known path, the practical effect was
-- "anyone can enumerate and download every customer's images".
--
-- New model (shipped in this batch):
--   * Customer page no longer calls createSignedUrl directly.
--   * New edge function customer-proof-images takes a proof
--     UUID, validates the proof exists, and returns signed URLs
--     server-side using service-role.
--   * Bucket privacy reverts to "designers only via the
--     authenticated SELECT policy that already exists".
--
-- ── H2: anon-write surface on the audit log ────────────────────
-- log_customer_event was a SECURITY DEFINER RPC granted to
-- anon, accepting arbitrary action / actor_email / target_id /
-- metadata with no validation. The single customer-side caller
-- (`version.viewed` on the proof page) is being removed in the
-- same shipment; customer view tracking continues unchanged via
-- the dedicated record_proof_view RPC writing to
-- proof_version_views, which has bounded inputs and is the
-- right surface for that semantic. The audit_log doesn't need
-- an anon-write surface — its purpose is forensic evidence of
-- staff actions.
--
-- ── Rollout sequencing ─────────────────────────────────────────
-- This migration MUST land AFTER the edge function and frontend
-- changes are deployed:
--   1. Deploy edge functions (new customer-proof-images, updated
--      Help Scout functions, updated _shared/admin.ts).
--   2. Deploy frontend (Netlify push) — customer page switches
--      to the edge function and stops calling log_customer_event.
--   3. Run this migration last.
-- Running this migration first would 500 the live customer page
-- (signed URL fetches fail) and break any in-flight version.viewed
-- writes (function does not exist).

begin;

-- H1: drop the anon SELECT policy. Authenticated SELECT stays
-- (designer image rendering paths in NewVersionPage,
-- EditVersionPage, ProofDetailPage, VersionDetailModal all run
-- as authenticated and use the existing
-- "proof-images: authenticated select" policy).
drop policy "proof-images: anon signed url" on storage.objects;

-- H2: drop the unbounded customer-side audit RPC. log_audit_event
-- (the authenticated-actor variant) stays in place — that's the
-- still-active path for designer/admin actions. The signature
-- match below has to enumerate the parameter types because
-- Postgres allows function overloading; this drops the specific
-- shape created in 000043.
drop function log_customer_event(text, text, text, text, text, text, jsonb);

commit;
