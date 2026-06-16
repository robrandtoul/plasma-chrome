-- 000230: public_get_order — anon read path for the customer pay-page.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Step 4 of the Ordering & checkout build. The customer pay-page (/order/:id)
-- is anonymous (no login), so it reads its order through a SECURITY DEFINER
-- RPC scoped to BOTH the order id AND the secret token — the same house
-- pattern as public_get_customer_proof (000162). proofs.orders stays
-- anon-revoked (migration 000229); this function is the only anon path in.
--
-- Requiring the token means anon can't enumerate orders by guessing UUIDs.
-- The token is not echoed back in the payload (stripped below) — the caller
-- already holds it in the URL. Any status / expiry is returned so the page
-- can render the right state (payable / already paid / expired); the page,
-- not the RPC, decides what to show.

create or replace function proofs.public_get_order(p_order_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select to_jsonb(o) - 'token'
  from proofs.orders o
  where o.id = p_order_id
    and o.token = p_token;
$$;

-- Anon (the pay-page) + authenticated (a designer previewing) may call it;
-- nothing else. Mirrors the grant shape of the other public_* RPCs.
revoke all on function proofs.public_get_order(uuid, text) from public;
grant execute on function proofs.public_get_order(uuid, text) to anon, authenticated;
