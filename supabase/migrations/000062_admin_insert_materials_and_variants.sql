-- Migration 000062: allow admins to insert materials and variants
--
-- 000037 gated UPDATE on materials and material_variants to is_admin()
-- but didn't add INSERT policies, on the assumption that catalogue rows
-- were only created by seed migrations. The admin "create material"
-- flow from phase 3a now needs both:
--
--   * INSERT on materials            — for the shell row itself
--   * INSERT on material_variants    — for the auto-created placeholder
--                                      variant when variant_type='default',
--                                      and for the future variant-creation UI
--
-- DELETE policies are intentionally still absent on both tables. Nothing
-- in the admin UI deletes catalogue rows; if we ever need to, we'll add
-- scoped DELETE policies then.
--
-- UPDATE policies audited at the same time: both tables carry
-- "admin update" policies with `using (is_admin())`, no column list and
-- no WITH CHECK, so is_published and variant_type are fully updatable
-- through the existing admin flows.

begin;

create policy "materials: admin insert"
  on materials for insert
  to authenticated
  with check (is_admin());

create policy "material_variants: admin insert"
  on material_variants for insert
  to authenticated
  with check (is_admin());

commit;
