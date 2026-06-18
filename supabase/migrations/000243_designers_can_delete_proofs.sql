-- Migration 000243: let designers delete their own projects
--
-- Migration 000074 gated DELETE on companies, contacts, and proofs to
-- is_admin(), so only an admin could permanently remove a project. In
-- practice a designer who creates a project by mistake -- wrong proof
-- type, wrong customer, a stray test -- needs to bin it themselves
-- rather than wait for an admin. Versions were always designer-
-- deletable (proof_versions DELETE is `using (true)`); this brings the
-- whole-project delete in line with that.
--
-- Scope: ONLY the proofs table is relaxed. companies and contacts stay
-- admin-only -- deleting a customer record is a heavier, separate action
-- that still lives on the admin Customers surface.
--
-- delete_proof_cascade() is SECURITY INVOKER and already granted to
-- authenticated, so it starts working for designers the moment this
-- policy lands. Every FK referencing proofs.proofs is ON DELETE CASCADE
-- (orders, proof_versions, proof_pins, proof_attention_snoozes,
-- proof_nudges -- verified against live 2026-06-18), so the cascade is
-- clean and no child row blocks the delete.
--
-- This is the exact inverse of 000074's proofs change: drop the
-- admin-only policy and restore the original "authenticated delete"
-- policy name. Schema-qualified for the merged stock-control project's
-- `proofs` schema (the live home of the proof viewer).

begin;

drop policy "proofs: admin delete" on proofs.proofs;

create policy "proofs: authenticated delete"
  on proofs.proofs for delete to authenticated using (true);

commit;
