-- Order hand-off Phase 0 — Stock Control-side safety net (docs/order-handoff-spec.md §4).
--
-- Prepares Stock Control's intake for the direct-write hand-off WITHOUT changing
-- any behaviour today. Two pieces:
--
--   1. `import_source` telemetry on both intake tables. NULLABLE, no default:
--      NULL means "not created by the direct path" (webhook-parsed AND hand-raised
--      rows both stay NULL, honestly). The direct-write RPC (000333) writes
--      'direct'. This is the parallel-run telemetry and the permanent backstop
--      alarm: an order the parser had to catch stays NULL.
--
--   2. Ref-based ADOPTION in create_outsourced_order_from_email. The direct path
--      inserts the outsourced_orders row BEFORE the supplier conversation exists
--      (it can't know the conversation id), so when the webhook later fires on
--      that new conversation it must claim the direct row instead of inserting a
--      duplicate.
--
--      ⚠ Deliberately NO unique index on customer_order_ref: one customer order
--      number legitimately maps to SEVERAL live supplier jobs. Verified on live
--      2026-07-20 — 403727 (gold cards at QX Metals + laminated cards at
--      Solopress), 403752 (two metals at QX), 403769 (two suppliers), 403790
--      (original + a hand-raised reprint). The adoption key is therefore
--      ref + supplier + quantity (quantity is the discriminator between two jobs
--      at one supplier under one ref), scoped to recent rows awaiting a
--      conversation id. The structural race guard is ordering: the direct row
--      COMMITS before place-order creates the supplier conversation, so by the
--      time the webhook can possibly fire, the row to adopt already exists.
--
-- Target: the merged stock-control project (public schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

alter table public.orders
  add column if not exists import_source text;
alter table public.outsourced_orders
  add column if not exists import_source text;

comment on column public.orders.import_source is
  'How this row was created: ''direct'' = proof-viewer''s create_order_handoff RPC; NULL = webhook note-parse or hand-raised. Backstop alarm reads this.';
comment on column public.outsourced_orders.import_source is
  'How this row was created: ''direct'' = proof-viewer''s create_order_handoff RPC; NULL = webhook email-parse or hand-raised. Backstop alarm reads this.';

-- Re-emit with the adoption block. Signature unchanged (CREATE OR REPLACE keeps
-- ownership + grants); everything outside the "Adopt a direct-write row" block
-- is byte-faithful to the live definition captured 2026-07-20.
create or replace function public.create_outsourced_order_from_email(
  p_supplier_id uuid,
  p_product_type_id uuid,
  p_quantity integer,
  p_customer_name text,
  p_customer_ref text,
  p_notes text,
  p_helpscout_id bigint,
  p_expected_ship_date date default null::date
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing  uuid;
  v_supplier  outsourced_suppliers%rowtype;
  v_ship      date;
  v_arrival   date;
  v_new_id    uuid;
begin
  if p_helpscout_id is null then
    raise exception 'p_helpscout_id is required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;
  if p_customer_name is null or trim(p_customer_name) = '' then
    raise exception 'p_customer_name is required';
  end if;

  select id into v_existing
    from outsourced_orders
    where helpscout_conversation_id = p_helpscout_id;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Adopt a direct-write row (order-handoff Phase 0). The direct hand-off
  -- inserts this job before its supplier conversation exists, leaving
  -- helpscout_conversation_id NULL. Claim it by ref + supplier + quantity —
  -- NOT ref alone, because one ref can carry several live supplier jobs
  -- (multi-material orders; see the migration header). STRICTLY gated on
  -- import_source = 'direct': hand-raised rows also sit with NULL conversation
  -- ids (33 such live rows in the last 90 days, verified 2026-07-20) and must
  -- keep getting their own webhook-inserted rows exactly as today. Recent rows
  -- only, newest first, so a re-placed job adopts the latest row. Fill the
  -- conversation id ONLY — every other field was written by the direct path
  -- and is authoritative.
  if p_customer_ref is not null and trim(p_customer_ref) <> '' then
    update outsourced_orders o
       set helpscout_conversation_id = p_helpscout_id
     where o.id = (
             select id
               from outsourced_orders
              where trim(coalesce(customer_order_ref, '')) = trim(p_customer_ref)
                and supplier_id = p_supplier_id
                and quantity = p_quantity
                and import_source = 'direct'
                and helpscout_conversation_id is null
                and status <> 'cancelled'
                and created_at > now() - interval '14 days'
              order by created_at desc
              limit 1
           )
    returning o.id into v_existing;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_supplier
    from outsourced_suppliers
    where id = p_supplier_id;
  if v_supplier.id is null then
    raise exception 'Unknown supplier';
  end if;
  if not v_supplier.active then
    raise exception 'Supplier % is inactive', v_supplier.name;
  end if;

  -- Ship date: agent override (Must ship by:) wins; otherwise
  -- fall back to the supplier's default lead time, same as a
  -- hand-raised order.
  if p_expected_ship_date is not null then
    v_ship := p_expected_ship_date;
  elsif v_supplier.default_lead_days is not null then
    v_ship := current_date + v_supplier.default_lead_days;
  end if;

  -- Arrival: ship + supplier shipping window, bumped to the
  -- next working day if it lands on a weekend. Domestic
  -- suppliers don't have a shipping leg, so arrival stays
  -- null for them (matches the manual modal's behaviour).
  if v_supplier.is_international
     and v_supplier.default_shipping_days is not null
     and v_ship is not null then
    v_arrival := v_ship + v_supplier.default_shipping_days;
    if extract(dow from v_arrival) = 6 then
      v_arrival := v_arrival + 2;
    elsif extract(dow from v_arrival) = 0 then
      v_arrival := v_arrival + 1;
    end if;
  end if;

  insert into outsourced_orders (
    supplier_id,
    product_type_id,
    quantity,
    customer_name,
    customer_order_ref,
    supplier_is_international,
    expected_ship_date,
    expected_arrival_date,
    notes,
    helpscout_conversation_id
  )
  values (
    p_supplier_id,
    p_product_type_id,
    p_quantity,
    trim(p_customer_name),
    nullif(trim(coalesce(p_customer_ref, '')), ''),
    coalesce(v_supplier.is_international, false),
    v_ship,
    v_arrival,
    nullif(trim(coalesce(p_notes, '')), ''),
    p_helpscout_id
  )
  returning id into v_new_id;

  return v_new_id;
end;
$function$;
