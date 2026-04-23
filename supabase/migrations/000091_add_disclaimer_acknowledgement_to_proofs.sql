-- Migration 000091: disclaimer acknowledgement on proofs
--
-- Adds four nullable columns capturing when + how the customer
-- acknowledges the proof terms. Scaffolds the future Approve
-- flow — Approve will be a hard gate requiring a non-null
-- disclaimer_acknowledged_at before any per-version approval
-- can be written.
--
-- Shape mirrors the approved_* columns added to
-- proof_versions in migration 000066 — same pattern, same
-- audit fields — but lives on PROOFS rather than
-- proof_versions because the terms describe the relationship
-- between Plasma and the customer, not a specific revision.
-- A customer who acknowledged terms on v1 has consented to the
-- same terms for v2, v3, and any future revision; they don't
-- re-acknowledge per upload.
--
-- Audit columns (ip, ua, name) stay on the base table and do
-- NOT get projected on public_proofs — they're designer-side
-- audit-only. Only the timestamp is exposed to the customer
-- surface (via migration 000092) so the confirmation line can
-- render without a refetch.
--
-- by_name column stays null for this shipment — the future
-- Approve flow captures the customer's name at approve-time
-- and writes to the version-scoped approved_by_name column.
-- The disclaimer ack is a silent click with no name prompt.

begin;

alter table proofs
  add column disclaimer_acknowledged_at       timestamptz null,
  add column disclaimer_acknowledged_by_name  text null,
  add column disclaimer_acknowledged_from_ip  text null,
  add column disclaimer_acknowledged_from_ua  text null;

commit;
