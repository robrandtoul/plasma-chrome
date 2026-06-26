-- 000275 — link a Stripe-paid order to an existing Xero contact.
--
-- The Stripe→Xero invoice path (stripe-webhook, Step 5b) builds the invoice
-- contact from the PAYER's Stripe checkout name/email, so each paid order spawned
-- a fresh, history-less Xero contact instead of filing under the customer's
-- existing Xero record. Now the designer picks the Xero customer in the Create
-- order modal; the chosen ContactID rides on the order and the webhook binds the
-- invoice to it (so "selecting a company in Xero shows all its invoices" works
-- again). When no contact is chosen — a genuinely new customer — Xero still
-- creates one and the webhook writes its ContactID back here, so the next order
-- for that customer pre-fills automatically.
--
-- Schema-qualified for the merged stock-control project's `proofs` schema. A
-- column added to an existing table inherits that table's grants, and
-- proofs.orders already carries the authenticated CRUD grant (000229), so no new
-- grant is needed. In practice these columns are written only by the
-- service-role edge functions (create-order, stripe-webhook, retry).

alter table proofs.orders
  add column if not exists xero_contact_id text,
  add column if not exists xero_contact_name text;

comment on column proofs.orders.xero_contact_id is
  'Xero ContactID the invoice is filed under. Chosen by the designer at order time (Create order modal), or written back by stripe-webhook from the contact Xero auto-created for a new customer. Null = let Xero match/create from the payer (legacy behaviour).';
comment on column proofs.orders.xero_contact_name is
  'Display name of the bound Xero contact, denormalised for the Orders log and the Create-order modal pre-fill so neither needs a Xero round-trip.';

-- Pre-fill source for the Create order modal: the Xero contact used on this
-- customer's most recent prior order (matched by company, or by the contact
-- itself when they have no company). Matching is by the contact's CURRENT
-- company, so if a contact moves company the pre-fill follows the new company's
-- recent orders — intentional company-level grouping, and only a convenience
-- default the designer confirms before saving. SECURITY INVOKER — the designer already has
-- SELECT on every table joined here (orders RLS is authenticated/true), so no
-- elevation is needed; we only pin search_path and lock the callable surface to
-- authenticated. Returns at most one row; empty when the customer has no prior
-- bound order (a genuinely new customer).
create or replace function proofs.last_xero_contact_for_proof(p_proof_id uuid)
returns table (xero_contact_id text, xero_contact_name text)
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
  select o.xero_contact_id, o.xero_contact_name
  from proofs.orders o
  join proofs.proofs p2 on p2.id = o.proof_id
  join proofs.contacts c2 on c2.id = p2.contact_id
  cross join target t
  where o.xero_contact_id is not null
    and case
      when t.company_id is not null then c2.company_id = t.company_id
      else c2.id = t.contact_id
    end
  order by o.created_at desc
  limit 1;
$$;

-- Postgres grants EXECUTE to PUBLIC on a new function by default; lock it to the
-- staff role only (anon is a member of public, so this also keeps it off the
-- customer/anon surface).
revoke execute on function proofs.last_xero_contact_for_proof(uuid) from public;
grant execute on function proofs.last_xero_contact_for_proof(uuid) to authenticated;
