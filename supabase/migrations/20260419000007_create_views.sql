-- Public views expose only customer-safe columns to anonymous users.
-- These views run with the permissions of their owner (postgres), so they
-- can read from the underlying tables regardless of RLS on the caller.
-- This is the standard Supabase pattern for column-level public access.

-- Safe columns from proofs (excludes helpscout_thread_url and internal_notes).
create or replace view public_proofs as
  select
    id,
    customer_name,
    company,
    created_at
  from proofs;

-- All columns from proof_versions are customer-safe.
-- This view exists so the customer page has a stable, explicit contract.
create or replace view public_proof_versions as
  select
    id,
    proof_id,
    version_number,
    image_path,
    material,
    ink_count,
    ink_names,
    currency,
    pricing_snapshot,
    shipping_note,
    change_notes,
    is_current,
    created_at
  from proof_versions;

-- Grant read access to both roles Supabase uses for API requests.
grant select on public_proofs          to anon, authenticated;
grant select on public_proof_versions  to anon, authenticated;
