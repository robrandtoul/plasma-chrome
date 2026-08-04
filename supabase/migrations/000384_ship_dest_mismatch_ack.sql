-- 000384: flag a delivery-postcode mismatch before payment completes (ship_dest_ack).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- THE GAP. The pay page collects the delivery postcode twice: once for rating
-- (create-checkout-session persists ship_dest_country / ship_dest_postcode)
-- and again inside Stripe's Address Element, whose value the webhook writes
-- straight into ship_to_address with no comparison. When Stripe's address
-- autocomplete resolves to the wrong place — ORD-F41E36FAE8: "4 Hughes Lane"
-- matched to Maldon CM9 6UA instead of Malpas SY14 7FB, two real streets with
-- one name — the wrong postcode wins silently and reaches the invoice and the
-- courier. 9 of 128 paid orders disagreed on 2026-08-04 under normalised
-- comparison.
--
-- THE FIX (three layers; this migration is the storage for layer 1's record):
--   1. The pay pages now compare the Address Element's value against the rated
--      destination before confirmPayment and ask the customer which is right.
--      Choosing "deliver to the address I've entered" records that choice HERE,
--      so support and the shipping paperwork can see the customer was asked.
--   2. stripe-webhook re-runs the same comparison as a backstop and puts the
--      order on hold (000377 fields) when the mismatch is unexplained — or
--      when it is COARSE (different GB area / US ZIP prefix / country), where
--      a wrong guess costs a reship, even if the customer confirmed it.
--   3. Nothing ever blocks the payment itself.
--
-- The ack is stored renderable, not as a boolean: both postcodes, the country
-- pair, the address line/city shown to the customer, the coarse verdict and a
-- timestamp — enough for the packing card to print "customer confirmed
-- CM9 6UA against a SY14 7FB quote on 4 Aug 2026" without a second lookup.
-- The rated pair is read from the ORDER ROW at stamp time, never from the
-- client, so it cannot be misstated; `coarse` is client-computed display
-- data only — the webhook recomputes it and trusts nothing.
--
-- Additive; columns inherit the tables' existing grants (000229 / 000309
-- matrix). Not exposed to pay-link holders: stripped from _customer_order_json
-- and from public_get_order_group's group serialisation below. Customers write
-- through the token-gated SECURITY DEFINER setters, exactly like
-- record_order_customs_tax_id (000341).

-- 1. The columns. Null = the gate never fired (or fired and they went back
--    and fixed the address, which clears nothing — a stale ack is harmless
--    because the webhook only honours an ack matching the FINAL address).
alter table proofs.orders
  add column if not exists ship_dest_ack jsonb;

alter table proofs.order_groups
  add column if not exists ship_dest_ack jsonb;

comment on column proofs.orders.ship_dest_ack is
  'Customer''s explicit "deliver to the address I''ve entered" choice when the pay page flagged that the card-form postcode differed from the rated one. Keys: rated_country, rated_postcode (from this row at stamp time), entered_country, entered_postcode, entered_line1, entered_city, coarse (client display only — the webhook recomputes), choice, at. Read by stripe-webhook''s hold decision and by the shipping paperwork.';
comment on column proofs.order_groups.ship_dest_ack is
  'Group-checkout twin of orders.ship_dest_ack (one address per group); copied onto every member order so per-order paperwork reads one place.';

-- 2. Token-gated setter for the anonymous single-order pay page. anon has no
--    write grant on proofs.orders (deliberately — 000162 / 000230 / 000262),
--    so the value goes through a SECURITY DEFINER RPC gated on the same secret
--    pay-link token as public_get_order. Only stamps a still-payable ('sent')
--    order, and only when an entered postcode is actually supplied.
create or replace function proofs.record_order_ship_dest_ack(
  p_order_id uuid,
  p_token text,
  p_entered_country text,
  p_entered_postcode text,
  p_entered_line1 text,
  p_entered_city text,
  p_coarse boolean
)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  update proofs.orders
     set ship_dest_ack = jsonb_build_object(
       'rated_country',    ship_dest_country,
       'rated_postcode',   ship_dest_postcode,
       'entered_country',  left(btrim(coalesce(p_entered_country, '')), 8),
       'entered_postcode', left(btrim(coalesce(p_entered_postcode, '')), 16),
       'entered_line1',    left(btrim(coalesce(p_entered_line1, '')), 120),
       'entered_city',     left(btrim(coalesce(p_entered_city, '')), 80),
       'coarse',           coalesce(p_coarse, false),
       'choice',           'use_address',
       'at',               now()
     )
   where id = p_order_id
     and token = p_token
     and status = 'sent'
     and nullif(btrim(p_entered_postcode), '') is not null;
$$;

revoke execute on function proofs.record_order_ship_dest_ack(uuid, text, text, text, text, text, boolean) from public;
grant  execute on function proofs.record_order_ship_dest_ack(uuid, text, text, text, text, text, boolean) to anon, authenticated;

-- 3. The combined-payment equivalent. A group has ONE recipient / delivery
--    address (000309), so the ack lives on the group and is copied onto every
--    member order for the per-order shipping paperwork — the same two-step
--    shape as record_order_group_customs_tax_id (000341), member update
--    guarded by the same token match so it can't be driven from a bare id.
create or replace function proofs.record_order_group_ship_dest_ack(
  p_group_id uuid,
  p_token text,
  p_entered_country text,
  p_entered_postcode text,
  p_entered_line1 text,
  p_entered_city text,
  p_coarse boolean
)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  update proofs.order_groups
     set ship_dest_ack = jsonb_build_object(
       'rated_country',    ship_dest_country,
       'rated_postcode',   ship_dest_postcode,
       'entered_country',  left(btrim(coalesce(p_entered_country, '')), 8),
       'entered_postcode', left(btrim(coalesce(p_entered_postcode, '')), 16),
       'entered_line1',    left(btrim(coalesce(p_entered_line1, '')), 120),
       'entered_city',     left(btrim(coalesce(p_entered_city, '')), 80),
       'coarse',           coalesce(p_coarse, false),
       'choice',           'use_address',
       'at',               now()
     )
   where id = p_group_id
     and token = p_token
     and status = 'sent'
     and nullif(btrim(p_entered_postcode), '') is not null;

  -- Rebuilt from the group row's columns + the params (the 000341 idiom)
  -- rather than reading back the jsonb the statement above just wrote — the
  -- value is identical either way, but this stays correct without leaning on
  -- statement-ordering semantics inside a SQL-language function.
  update proofs.orders o
     set ship_dest_ack = jsonb_build_object(
       'rated_country',    g.ship_dest_country,
       'rated_postcode',   g.ship_dest_postcode,
       'entered_country',  left(btrim(coalesce(p_entered_country, '')), 8),
       'entered_postcode', left(btrim(coalesce(p_entered_postcode, '')), 16),
       'entered_line1',    left(btrim(coalesce(p_entered_line1, '')), 120),
       'entered_city',     left(btrim(coalesce(p_entered_city, '')), 80),
       'coarse',           coalesce(p_coarse, false),
       'choice',           'use_address',
       'at',               now()
     )
    from proofs.order_groups g
   where g.id = p_group_id
     and o.order_group_id = p_group_id
     and g.token = p_token
     and g.status = 'sent'
     and nullif(btrim(p_entered_postcode), '') is not null;
$$;

revoke execute on function proofs.record_order_group_ship_dest_ack(uuid, text, text, text, text, text, boolean) from public;
grant  execute on function proofs.record_order_group_ship_dest_ack(uuid, text, text, text, text, text, boolean) to anon, authenticated;

-- 4. Keep the ack off the customer's pay page. The 000365 rule: any new
--    proofs.orders column a customer must not see goes on the
--    _customer_order_json strip list in the SAME migration that adds it.
--    Nothing on the pay pages reads the ack back, and the coarse verdict is
--    an internal judgement, so it is stripped like the hold fields are.
--
--    Body below is the LIVE pg_get_functiondef read on 2026-08-04 (which
--    already carries 000382's blanks_source_order_id strip — never rebuild
--    this from an older migration file), plus the one new strip.
create or replace function proofs._customer_order_json(o proofs.orders)
returns jsonb
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  select (to_jsonb(o)
            - 'token'
            -- Production / supplier internals
            - 'stock_order_number'
            - 'supplier_id'
            - 'supplier_name'
            - 'supplier_helpscout_conversation_id'
            - 'supplier_overs'
            - 'supplier_email_sent_at'
            - 'dropbox_folder_url'
            - 'stock_colour'
            - 'date_required'
            - 'project_name'
            - 'production_note_posted_at'
            - 'handoff_at'
            - 'handoff_payload'
            - 'handoff_error'
            -- AI artwork check (report quotes Help Scout thread content)
            - 'artwork_check'
            - 'artwork_checked_at'
            - 'artwork_check_verdict'
            - 'artwork_check_running_at'
            -- Internal hold: the reason is a staff note about the customer,
            -- and the flag snapshot carries artwork-check report text.
            - 'held_at'
            - 'hold_reason'
            - 'held_by'
            - 'held_by_name'
            - 'hold_artwork_flag'
            -- Xero / invoicing internals
            - 'xero_invoice_id'
            - 'xero_invoice_error'
            - 'xero_contact_id'
            - 'xero_contact_name'
            - 'invoice_emailed_at'
            - 'confirmation_sent_at'
            -- Staff attribution + internal notes / refs / telemetry
            - 'created_by'
            - 'fulfilled_by'
            - 'card_discount_reason'
            - 'reprint_of_order_id'
            - 'blanks_source_order_id'  -- NEW (000382): sibling-order provenance pointer
            - 'shipping_discount_percent'
            - 'pay_link_opened_at'
            -- Delivery-postcode mismatch ack (000384): internal record of the
            -- gate having fired; the pages never read it back
            - 'ship_dest_ack'
            -- Recipient contact details Stripe collected — shown nowhere on
            -- the pay pages, so they don't ride a forwardable link
            - 'ship_to_email'
            - 'ship_to_phone')
         || jsonb_build_object(
              'order_spec_snapshot',
              case
                when jsonb_typeof(o.order_spec_snapshot) = 'object'
                  then o.order_spec_snapshot - 'contact' - 'company' - 'captured_by'
                else null
              end
            )
$function$;

comment on function proofs._customer_order_json(proofs.orders) is
  'Single strip list for BOTH pay-page RPCs (public_get_order, public_get_order_group). Any new proofs.orders column a customer must not see goes on this list in the SAME migration that adds the column. Never serialise order rows with a bare to_jsonb(o) - ''token'' — that regression shipped twice (000230->000265, 000268->000309).';

-- 5. Same for the GROUP row: public_get_order_group serialises the group with
--    its own inline strip list, so the group-level ack needs stripping there.
--    Body below is the LIVE pg_get_functiondef read on 2026-08-04, plus the
--    one new strip; member orders already flow through _customer_order_json.
create or replace function proofs.public_get_order_group(p_group_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  select jsonb_build_object(
    'group', to_jsonb(g)
               - 'token'
               - 'xero_contact_id'
               - 'xero_contact_name'
               - 'xero_invoice_id'
               - 'xero_invoice_error'
               - 'invoice_emailed_at'
               - 'confirmation_sent_at'
               - 'created_by'
               - 'shipping_discount_percent'
               - 'pay_link_opened_at'
               - 'ship_to_email'
               - 'ship_to_phone'
               - 'ship_dest_ack',
    'orders', coalesce(
      (
        select jsonb_agg(proofs._customer_order_json(o) order by o.created_at, o.id)
        from proofs.orders o
        where o.order_group_id = g.id
      ),
      '[]'::jsonb
    ),
    'company_name', (
      select coalesce(co.name, c.full_name)
      from proofs.orders o2
      join proofs.proofs p on p.id = o2.proof_id
      left join proofs.contacts c on c.id = p.contact_id
      left join proofs.companies co on co.id = c.company_id
      where o2.order_group_id = g.id
      order by o2.created_at, o2.id
      limit 1
    )
  )
  from proofs.order_groups g
  where g.id = p_group_id
    and g.token = p_token;
$function$;
