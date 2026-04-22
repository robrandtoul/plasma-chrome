-- Migration 000077: widen DELETE on proof_name_approvals to authenticated
--
-- Migration 000076 created proof_name_approvals with SELECT / INSERT /
-- UPDATE open to authenticated and DELETE restricted to is_admin(),
-- mirroring the pattern applied to companies / contacts / proofs in
-- 000074. That pattern made sense for the customer tables where DELETE
-- enumerates or destroys real business data — but an approval row is a
-- per-(version, name) audit record that any designer might legitimately
-- reset.
--
-- The Clear action in VersionDetailModal (commit 61affe4) needs DELETE
-- to work for non-admin designers too — clearing an approval is part of
-- the edit flow, and restricting it to admins created an asymmetric
-- write surface (designers can add, update, but not clear). Row
-- semantics don't justify the admin gate: the only sensitive data on
-- these rows is actor_name (typed freely into a dialog) and the
-- change_request note, and clearing is reversible by re-submitting via
-- the approve / changes buttons.

begin;

drop policy if exists "proof_name_approvals: admin delete" on proof_name_approvals;

create policy "proof_name_approvals: authenticated delete"
  on proof_name_approvals for delete to authenticated using (true);

commit;
