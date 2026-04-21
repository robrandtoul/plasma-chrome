-- Migration 000063: allow admins to insert and delete price tiers
--
-- 000037 layered an admin-only UPDATE policy on price_tiers but left
-- INSERT and DELETE with no policy (000010's permissive ones were
-- dropped in 000040). That's the same gap we closed for materials and
-- material_variants in 000062.
--
-- Phase 3b.2 lets admins add and remove price tiers from the pricing
-- editor. Adding a tier writes three price_tiers rows (one per
-- currency) in a single batch INSERT; removing a tier deletes all
-- three in a single DELETE filtered by (material_variant_id, quantity).
-- Both operations need these two new policies.
--
-- UPDATE stays as it was — editing an existing tier's total_price is
-- covered by the admin-only UPDATE policy from 000037.

begin;

create policy "price_tiers: admin insert"
  on price_tiers for insert
  to authenticated
  with check (is_admin());

create policy "price_tiers: admin delete"
  on price_tiers for delete
  to authenticated
  using (is_admin());

commit;
