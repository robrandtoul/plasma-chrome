-- 000364 — "same as last time" guidance for returning customers.
--
-- Returning customers (sometimes years after their last order) usually want
-- exactly what they had before, but locking the pay link to the old spec would
-- stop them choosing differently, and leaving it fully open risks an accidental
-- switch. The answer is a third posture: leave the choosers open, but label the
-- option they had last time ("Your last order · March 2022") and show a gentle
-- note if they pick something else. Two pieces of schema back that up:
--
-- 1. `orders.previous_spec` — a small jsonb of what the customer ordered last
--    time, written once by create-order from the designer's confirmation in the
--    order builder (auto-suggested from their order history, or entered by hand
--    after checking old Help Scout threads / Xero invoices). Display guidance
--    only: it never feeds pricing, production, or the invoice.
--
--    ⚠ CUSTOMER-VISIBLE BY CONSTRUCTION. public_get_order and
--    public_get_order_group serialise the whole orders row (`to_jsonb(o) -
--    'token'`), so every key stored here reaches the token-gated pay page.
--    Only display-safe fields belong in it: { variant_id, variant_label,
--    option_id, option_label, quantity, label, source } — no Help Scout ids,
--    no internal notes, no other-order references.
--
-- 2. `last_paid_order_for_proof()` — the order builder's auto-suggest source:
--    this customer's most recent PAID order of the same material. Clones the
--    matching semantics of last_xero_contact_for_proof (000275): match by the
--    contact's current company, or by the contact themselves when they have no
--    company. Paid means status in ('paid','fulfilled') — fulfilled is the
--    dominant terminal state on live. Production orders only: a prototype is a
--    sample run, and a REPRINT would poison the suggestion — a partial reprint
--    stores only the faulty subset as its quantity (100 of a 500 order) and is
--    born paid with a fresh paid_at, so it would shadow the genuine order,
--    which is still in the table as the honest record. Material matching falls
--    back through the variant's material because material_id is only stamped
--    on orders since 000298 — 37 live paid orders (counted 2026-07-28) carry a
--    variant but a NULL material_id, and matching on the column alone would
--    silently miss them. Rows with no variant, no finish AND no quantity (a
--    paid custom quote can be all three) are skipped — they'd render an empty
--    suggestion the builder can't do anything with.
--
-- Schema-qualified for the merged stock-control project's `proofs` schema. The
-- new column inherits proofs.orders' existing grants (authenticated CRUD per
-- 000229/000176; anon has none — anon reads flow only through the SECURITY
-- DEFINER pay-page RPCs, which pick the column up automatically, so no view or
-- RPC re-emit is needed).

alter table proofs.orders
  add column if not exists previous_spec jsonb;

comment on column proofs.orders.previous_spec is
  'What this customer ordered last time, for the pay page''s "Your last order" guidance on open thickness/finish/quantity choosers. Designer-confirmed display data only ({variant_id, variant_label, option_id, option_label, quantity, label, source}) — never feeds pricing, production, or the invoice. Customer-visible via public_get_order, so display-safe fields only. Null = no guidance shown.';

-- Auto-suggest source for the order builder. SECURITY INVOKER — the designer
-- already has SELECT on every table joined here (orders/proofs/contacts RLS is
-- authenticated/true, the catalogue tables likewise), so no elevation is
-- needed; we only pin search_path and lock the callable surface. Returns at
-- most one row; empty when the customer has no prior paid order of this
-- material (a genuinely new customer, or a first order of a new material).
-- Labels are frozen strings from the catalogue joins so the pay page can still
-- name a variant/finish that later gets retired or renamed.
create or replace function proofs.last_paid_order_for_proof(p_proof_id uuid, p_material_id uuid)
returns table (
  order_id uuid,
  variant_id uuid,
  variant_label text,
  option_id uuid,
  option_label text,
  quantity integer,
  paid_at timestamptz
)
language sql
stable
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  with target as (
    select c.id as contact_id, c.company_id
    from proofs.proofs p
    join proofs.contacts c on c.id = p.contact_id
    where p.id = p_proof_id
  )
  select
    o.id,
    o.material_variant_id,
    mv.display_name,
    o.material_option_id,
    mo.display_name,
    o.quantity,
    coalesce(o.paid_at, o.created_at)
  from proofs.orders o
  join proofs.proofs p2 on p2.id = o.proof_id
  join proofs.contacts c2 on c2.id = p2.contact_id
  left join proofs.material_variants mv on mv.id = o.material_variant_id
  left join proofs.material_options mo on mo.id = o.material_option_id
  cross join target t
  where p_material_id is not null
    and o.status in ('paid', 'fulfilled')
    and o.order_kind = 'production'
    and (o.material_variant_id is not null or o.material_option_id is not null or o.quantity is not null)
    and coalesce(o.material_id, mv.material_id) = p_material_id
    and case
      when t.company_id is not null then c2.company_id = t.company_id
      else c2.id = t.contact_id
    end
  order by coalesce(o.paid_at, o.created_at) desc
  limit 1;
$$;

-- Postgres grants EXECUTE to PUBLIC on a new function by default, and the
-- proofs schema has no default function ACL, so this revoke is load-bearing
-- (anon holds schema USAGE and PostgREST would otherwise serve the function to
-- the public internet — the 000356 lesson). Staff-only surface.
revoke execute on function proofs.last_paid_order_for_proof(uuid, uuid) from public, anon;
grant execute on function proofs.last_paid_order_for_proof(uuid, uuid) to authenticated;
