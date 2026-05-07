-- Migration 000140: variant rounds — widen proof_round_variants RLS
-- to authenticated insert / update / delete.
--
-- Migration 000138 enabled RLS on proof_round_variants with a single
-- "authenticated read" policy and no write policies — service-role
-- bypass model, mirroring the proof_events shape (000116). Step 5 of
-- the variant-rounds build plan adds the designer-side upload UI which
-- writes variant rows directly via supabase-js authenticated client.
-- That requires matching INSERT / UPDATE / DELETE policies.
--
-- Pattern mirrors proof_versions (000010 / 000011): authenticated has
-- full CRUD with using/with-check (true). Same shape as the parent
-- table; proof_round_variants is a child of proof_versions and the
-- policies travel together. No admin-only DELETE on this child either
-- — designers manage variants directly during the EditVersionPage
-- variant-editor flow without an admin escalation.
--
-- The existing "proof_round_variants: authenticated read" policy from
-- 000138 stays untouched.
--
-- Idempotent via the pg_policies existence-check pattern from 000116.
-- Re-applying this migration is a no-op.

begin;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'proof_round_variants'
      and policyname = 'proof_round_variants: authenticated insert'
  ) then
    create policy "proof_round_variants: authenticated insert"
      on proof_round_variants for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'proof_round_variants'
      and policyname = 'proof_round_variants: authenticated update'
  ) then
    create policy "proof_round_variants: authenticated update"
      on proof_round_variants for update
      to authenticated
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'proof_round_variants'
      and policyname = 'proof_round_variants: authenticated delete'
  ) then
    create policy "proof_round_variants: authenticated delete"
      on proof_round_variants for delete
      to authenticated
      using (true);
  end if;
end$$;

commit;
