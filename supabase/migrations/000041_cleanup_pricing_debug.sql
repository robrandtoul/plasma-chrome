-- Migration 000041: restore Rob's admin role + reset a test-edited tier
--
-- Housekeeping after the pricing RLS debugging:
--   1. Earlier verification demoted rob.randtoul@gmail.com to designer;
--      restore the admin role so the app is usable again.
--   2. A test update to Steel 300-micron / GBP / qty 50 left it at 22222;
--      reset it back to the seeded value (279.00, unit 5.58).
--   3. Drop the temporary debug_rls_status / debug_list_policies RPCs
--      that were only added to troubleshoot the RLS pre-existing policies.

begin;

update profiles
  set role = 'admin'
  where id = (select id from auth.users where email = 'rob.randtoul@gmail.com');

update price_tiers
  set total_price = 279.00, unit_price = 5.58
  where currency = 'GBP'
    and quantity = 50
    and material_variant_id = (
      select mv.id from material_variants mv
      join materials m on m.id = mv.material_id
      where m.code = 'metal_steel' and mv.code = '300um'
    );

drop function if exists debug_rls_status();
drop function if exists debug_list_policies();

commit;
