-- 000305: recent_paid_orders RPC — the read-only orders feed for the
-- Google Ads offline conversions pipeline in plasma-forms.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- plasma-forms' nightly scheduled function calls this with a cursor and
-- receives every order paid since then, joined to the proof's Help Scout
-- conversation id and the contact's email — the two keys it matches against
-- artwork_submissions before uploading conversions to Google Ads. See
-- plasma-forms docs/Google Ads Offline Conversions - Plan.md.
--
-- Read-only, SECURITY DEFINER, callable by service_role ONLY: the caller is
-- a server-side function holding a dedicated secret API key for this project.
-- anon and authenticated get nothing (this returns cross-customer PII).
--
-- goods_total mirrors the Xero invoice's product revenue: the custom-quote
-- total when there is one, otherwise cards + tooling + personalisation minus
-- any card discount. Shipping and US tariff are returned separately so the
-- conversion value can exclude them.

create or replace function proofs.recent_paid_orders(p_since timestamptz)
returns table (
  order_id                  uuid,
  payment_reference         text,
  xero_invoice_id           text,
  paid_at                   timestamptz,
  currency                  text,
  order_kind                text,
  goods_total               numeric,
  amount_shipping           numeric,
  amount_us_tariff          numeric,
  helpscout_conversation_id text,
  contact_email             text,
  contact_name              text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id,
    o.payment_reference,
    o.xero_invoice_id,
    o.paid_at,
    o.currency,
    o.order_kind,
    coalesce(
      o.custom_quote_total,
      coalesce(o.amount_cards, 0)
        + coalesce(o.amount_tooling, 0)
        + coalesce(o.amount_personalisation, 0)
        - coalesce(o.amount_card_discount, 0)
    ) as goods_total,
    o.amount_shipping,
    o.amount_us_tariff,
    p.helpscout_conversation_id,
    lower(trim(c.email)) as contact_email,
    c.full_name as contact_name
  from proofs.orders o
  join proofs.proofs p on p.id = o.proof_id
  left join proofs.contacts c on c.id = p.contact_id
  where o.paid_at is not null
    and o.paid_at >= p_since
    and o.status in ('paid', 'fulfilled')
  order by o.paid_at asc
$$;

-- service_role only. The 000176 default privileges do not apply to
-- functions, but be explicit anyway.
revoke execute on function proofs.recent_paid_orders(timestamptz)
  from public, anon, authenticated;
grant execute on function proofs.recent_paid_orders(timestamptz)
  to service_role;
