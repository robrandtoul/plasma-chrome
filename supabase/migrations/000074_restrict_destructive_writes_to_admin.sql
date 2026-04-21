-- Migration 000074: gate customer-table DELETEs to admins
--
-- Before this pass, every authenticated user could issue DELETE against
-- companies, contacts, and proofs directly via PostgREST. The UI only
-- exposes those operations on admin-gated surfaces today (the Customers
-- page is admin-only as of commit 96e8dba, and the Delete project button
-- on ProofDetailPage is wrapped with a role === 'admin' check in the
-- same commit that ships this migration), but the policy layer was still
-- permissive, so a non-admin with the Supabase client could wipe rows
-- directly.
--
-- SELECT / INSERT / UPDATE on the three tables stay open to authenticated
-- users. Designers legitimately need read access everywhere (proof detail
-- headers, dashboard joins, new-project pickers), INSERT covers the
-- new-project and new-contact flows, and UPDATE covers mid-project edits
-- of contact details. The enumeration risk documented in discovery is
-- accepted for this pass — this migration only addresses the destructive
-- write surface.
--
-- Pattern lifted from 000037_pricing_admin_rls.sql, which introduced the
-- is_admin() predicate on pricing-table writes, and follow the same
-- "table: admin delete" naming used there and in 000062 / 000063.

begin;

-- ── DELETE: admin only ───────────────────────────────────────────────────────

drop policy "companies: authenticated delete" on companies;
create policy "companies: admin delete"
  on companies for delete to authenticated using (is_admin());

drop policy "contacts: authenticated delete" on contacts;
create policy "contacts: admin delete"
  on contacts for delete to authenticated using (is_admin());

drop policy "proofs: authenticated delete" on proofs;
create policy "proofs: admin delete"
  on proofs for delete to authenticated using (is_admin());

commit;
