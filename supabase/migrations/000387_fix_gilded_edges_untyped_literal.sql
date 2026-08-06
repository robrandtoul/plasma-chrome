-- 000387: type the 'Gilded edges' job-card part so a gilded letterpress order
-- can actually be placed.
--
-- The first gilded in-house order through the LIVE direct hand-off (Ayla
-- Advisory, order 403976 / dbdd801e, 2026-08-06) failed at confirm with
--   malformed array literal: "Gilded edges"
-- and rolled back cleanly (nothing reached Stock Control, the order stayed
-- placeable). The cause is the one bare UNTYPED string literal appended to
-- v_parts. With an untyped literal on the right, Postgres resolves
-- text[] || 'x' as array CONCATENATION (array_cat) rather than append, and so
-- tries to parse 'Gilded edges' as an array literal - which must start with
-- '{'. Every other v_parts append is a parenthesised expression of known text
-- type (format(...), 'Date required: ' || to_char(...)), which resolves to
-- array_append; that is why only the gilding branch could fire. The line
-- shipped in 000360 and was preserved verbatim by the 000383 re-emit; it had
-- never executed before this order because the parts block runs only on the
-- execute path (p_validate_only = false), so previews never touched it.
--
-- Fix: the literal gains an explicit ::text, making the append the same typed
-- shape as its siblings. Nothing else changes - this re-emits the LIVE
-- definition (verified 2026-08-06: live prosrc md5
-- bbee83579cf63cea9bae5b1a22d0589d == the 000383 source, no drift) with that
-- single token added. ACL restated per the house pattern (CREATE OR REPLACE
-- keeps grants; a fresh replay needs them stated).
--
-- Apply to the merged stock project (bjvinrzbdrwebylkmbwy) via MCP
-- apply_migration / dashboard SQL editor - never CLI db push.

create or replace function public.create_order_handoff(
  p_payload jsonb,
  p_spec_snapshot jsonb default null,
  p_validate_only boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'proofs', 'pg_temp'
as $function$
declare
  v_problems jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;

  v_pv_order uuid;
  v_placed_by uuid;
  v_route text;
  v_number text;
  v_customer text;
  v_conv bigint;
  v_qty int;
  v_supplier_qty int;
  v_overs int;
  v_is_prototype boolean;
  v_date_required date;
  v_note text;

  v_mat jsonb;
  v_mat_code text;
  v_card_line text;
  v_lp jsonb;
  v_is_letterpress boolean := false;
  v_sc_material_id uuid;
  v_sc_material_name text;
  v_pv_material_id uuid;
  v_map_target uuid;
  v_match_count int;

  v_sup jsonb;
  v_supplier_id uuid;
  v_supplier outsourced_suppliers%rowtype;
  v_product_type_id uuid;
  v_product_type_name text;
  v_must_ship_by date;
  v_ship date;
  v_arrival date;

  v_existing_job uuid;
  v_existing_customer text;
  v_pre_existing uuid;
  v_sc_order_id uuid;
  v_sc_order_table text;
  v_already boolean := false;

  v_status text;
  v_handoff_at timestamptz;
  v_notes text;
  v_parts text[];
  v_split jsonb;
  v_split_sum int := 0;
  v_split_n int := 0;
  v_split_text text;
  v_line jsonb;
  v_rows int;

  v_norm_target text;

  -- 000383: "base cards supplied under another order's batch". Presence of the
  -- payload's blanks_source object flips the material rules below from
  -- problems to warnings and allows a lineless in-house job.
  v_blanks jsonb;
  v_is_blanks boolean := false;
begin
  v_route    := p_payload ->> 'route';
  v_number   := trim(coalesce(p_payload ->> 'stock_order_number', ''));
  if v_route = 'in_house' then
    v_customer := coalesce(
      nullif(trim(coalesce(p_payload ->> 'project_name', '')), ''),
      nullif(trim(coalesce(p_payload ->> 'customer_name', '')), '')
    );
  else
    v_customer := nullif(trim(coalesce(p_payload ->> 'customer_name', '')), '');
  end if;
  v_note     := nullif(trim(coalesce(p_payload ->> 'note', '')), '');
  v_mat      := p_payload -> 'material';
  v_sup      := p_payload -> 'supplier';
  v_split    := coalesce(p_payload -> 'split', '[]'::jsonb);
  -- 000383
  v_blanks    := p_payload -> 'blanks_source';
  v_is_blanks := v_blanks is not null and jsonb_typeof(v_blanks) = 'object';

  begin
    v_pv_order  := nullif(p_payload ->> 'pv_order_id', '')::uuid;
    v_placed_by := nullif(p_payload ->> 'placed_by', '')::uuid;
  exception when others then
    v_problems := v_problems || jsonb_build_object('code', 'bad_ids', 'message', 'pv_order_id / placed_by are not valid ids.');
  end;

  if (p_payload ->> 'helpscout_conversation_id') ~ '^\d{1,18}$' then
    v_conv := (p_payload ->> 'helpscout_conversation_id')::bigint;
  elsif nullif(p_payload ->> 'helpscout_conversation_id', '') is not null then
    v_warnings := v_warnings || jsonb_build_object('code', 'conversation_id_ignored', 'message', 'The Help Scout conversation id is not numeric and was ignored.');
  end if;

  begin
    v_qty := coalesce(nullif(p_payload ->> 'qty', '')::int, 0);
    v_supplier_qty := coalesce(nullif(p_payload ->> 'supplier_qty', '')::int, v_qty);
    v_overs := coalesce(nullif(p_payload ->> 'supplier_overs', '')::int, 0);
    v_is_prototype := coalesce((p_payload -> 'prototype' ->> 'is_prototype')::boolean, false);
  exception when others then
    v_qty := coalesce(v_qty, 0);
    v_supplier_qty := coalesce(v_supplier_qty, v_qty);
    v_overs := coalesce(v_overs, 0);
    v_is_prototype := coalesce(v_is_prototype, false);
    v_problems := v_problems || jsonb_build_object('code', 'bad_numbers', 'message', 'Quantity / overs / prototype fields must be whole numbers (a per-person split of 50.5 cards, say, can''t be produced).');
  end;

  begin
    v_date_required := nullif(p_payload ->> 'date_required', '')::date;
  exception when others then
    v_warnings := v_warnings || jsonb_build_object('code', 'date_required_invalid', 'message', 'Date required could not be read and was left off the job card.');
  end;

  begin
    if coalesce((p_payload ->> 'payload_version')::int, 0) <> 1 then
      raise exception 'version';
    end if;
  exception when others then
    v_warnings := v_warnings || jsonb_build_object('code', 'payload_version', 'message', 'Unexpected payload version — fields this importer doesn''t know are ignored.');
  end;
  if v_route not in ('in_house', 'supplier') then
    v_problems := v_problems || jsonb_build_object('code', 'route_invalid', 'message', 'The hand-off route must be in_house or supplier.');
  end if;
  if v_number = '' then
    v_problems := v_problems || jsonb_build_object('code', 'number_missing', 'message', 'No Stock Control order number (link the Dropbox order folder first).');
  end if;
  if v_customer is null then
    v_problems := v_problems || jsonb_build_object('code', 'customer_missing', 'message', 'No customer name.');
  end if;
  if v_qty <= 0 then
    v_problems := v_problems || jsonb_build_object('code', 'qty_invalid', 'message', 'Quantity must be a positive number of cards.');
  end if;
  if v_supplier_qty < v_qty then
    v_problems := v_problems || jsonb_build_object('code', 'supplier_qty_invalid', 'message', 'Supplier quantity is below the customer quantity.');
  end if;

  begin
    select count(*), coalesce(sum((e ->> 'qty')::int), 0)
      into v_split_n, v_split_sum
      from jsonb_array_elements(v_split) e;
  exception when others then
    v_split_n := 0;
    v_split_sum := 0;
    v_problems := v_problems || jsonb_build_object('code', 'split_invalid', 'message', 'The per-person split contains a quantity that isn''t a whole number.');
  end;
  if v_split_n >= 2 and v_split_sum <> v_qty then
    v_problems := v_problems || jsonb_build_object('code', 'split_mismatch', 'message',
      format('The per-person split sums to %s but the quantity is %s.', v_split_sum, v_qty));
  end if;

  if v_route = 'in_house' then
    v_mat_code  := coalesce(v_mat ->> 'code', '');
    v_card_line := nullif(trim(coalesce(v_mat ->> 'card_line', '')), '');
    v_lp        := v_mat -> 'letterpress';
    v_is_letterpress := v_mat_code in ('paper_letterpress', 'paper_letterpress_gilded');

    if v_is_letterpress then
      if nullif(trim(coalesce(v_lp ->> 'front', '')), '') is null
         or nullif(trim(coalesce(v_lp ->> 'core', '')), '') is null
         or nullif(trim(coalesce(v_lp ->> 'back', '')), '') is null then
        v_problems := v_problems || jsonb_build_object('code', 'letterpress_colours_missing', 'message', 'A letterpress order needs its Front, Core and Back colours.');
      end if;
    else
      begin
        v_pv_material_id := nullif(v_mat ->> 'pv_material_id', '')::uuid;
      exception when others then
        v_pv_material_id := null;
      end;
      if v_pv_material_id is not null then
        select stock_material_id into v_map_target
          from proofs.materials where id = v_pv_material_id;
      end if;

      if v_map_target is not null then
        select m.id, m.name into v_sc_material_id, v_sc_material_name
          from public.materials m
         where m.id = v_map_target and not m.archived;
        if v_sc_material_id is null then
          -- 000383: a blanks-source job tolerates this — the job goes in
          -- without a material line (supplier blanks aren't sheet stock).
          if v_is_blanks then
            v_warnings := v_warnings || jsonb_build_object('code', 'material_line_skipped', 'message',
              'The mapped Stock Control material no longer exists — the job will go in without a material line (fine for supplier-blank finishing).');
          else
            v_problems := v_problems || jsonb_build_object('code', 'material_mapping_stale', 'message',
              'The Stock Control material this maps to no longer exists (or is archived) — fix it in Admin → Catalogue data → Stock materials.');
          end if;
        end if;
      elsif v_card_line is not null then
        v_norm_target := lower(regexp_replace(v_card_line, '\s+', ' ', 'g'));
        select count(*), min(m.id::text)::uuid, min(m.name)
          into v_match_count, v_sc_material_id, v_sc_material_name
          from public.materials m
         where not m.archived and not m.is_custom
           and lower(regexp_replace(m.name, '\s+', ' ', 'g')) = v_norm_target;
        if v_match_count = 0 then
          select count(*), min(m.id::text)::uuid, min(m.name)
            into v_match_count, v_sc_material_id, v_sc_material_name
            from public.materials m
           where not m.archived and not m.is_custom
             and regexp_replace(regexp_replace(lower(regexp_replace(m.name, '\s+', ' ', 'g')), '\s+\d+(\.\d+)?\s*mm$', ''), '\s+(plastic|card|cards)$', '')
               = regexp_replace(regexp_replace(v_norm_target, '\s+\d+(\.\d+)?\s*mm$', ''), '\s+(plastic|card|cards)$', '');
        end if;
        if v_match_count = 0 then
          v_sc_material_id := null;
          -- 000383: warning, not problem, on a blanks-source job.
          if v_is_blanks then
            v_warnings := v_warnings || jsonb_build_object('code', 'material_line_skipped', 'message',
              format('"%s" isn''t a Stock Control material — the job will go in without a material line (fine for supplier-blank finishing; map it in Admin → Catalogue data → Stock materials to change that).', v_card_line));
          else
            v_problems := v_problems || jsonb_build_object('code', 'material_unmapped', 'message',
              format('"%s" doesn''t match any Stock Control material — set the mapping in Admin → Catalogue data → Stock materials.', v_card_line));
          end if;
        elsif v_match_count > 1 then
          v_sc_material_id := null;
          -- 000383: warning, not problem, on a blanks-source job.
          if v_is_blanks then
            v_warnings := v_warnings || jsonb_build_object('code', 'material_line_skipped', 'message',
              format('"%s" matches more than one Stock Control material — the job will go in without a material line (set the explicit mapping to change that).', v_card_line));
          else
            v_problems := v_problems || jsonb_build_object('code', 'material_ambiguous', 'message',
              format('"%s" matches more than one Stock Control material — set the explicit mapping in Admin → Catalogue data → Stock materials.', v_card_line));
          end if;
        end if;
      else
        -- 000383: warning, not problem, on a blanks-source job.
        if v_is_blanks then
          v_warnings := v_warnings || jsonb_build_object('code', 'material_line_skipped', 'message',
            'No material recorded on this order — the job will go in without a material line.');
        else
          v_problems := v_problems || jsonb_build_object('code', 'material_missing', 'message', 'No material on this order.');
        end if;
      end if;
    end if;

    if v_number <> '' then
      select o.id, o.customer_name into v_existing_job, v_existing_customer
        from public.orders o
       where o.inhouse_order_no = v_number and o.status <> 'cancelled';
      if v_existing_job is not null then
        v_warnings := v_warnings || jsonb_build_object('code', 'number_in_use', 'message',
          format('Stock Control already has a live job numbered %s (%s) — the hand-off will attach to it rather than create a duplicate.', v_number, coalesce(v_existing_customer, 'no customer name')));
      end if;
    end if;

  elsif v_route = 'supplier' then
    begin
      v_supplier_id := nullif(v_sup ->> 'supplier_id', '')::uuid;
    exception when others then
      v_supplier_id := null;
    end;
    if v_supplier_id is null then
      v_problems := v_problems || jsonb_build_object('code', 'supplier_missing', 'message', 'Choose a supplier to order from.');
    else
      select * into v_supplier from outsourced_suppliers where id = v_supplier_id;
      if v_supplier.id is null then
        v_problems := v_problems || jsonb_build_object('code', 'supplier_unknown', 'message', 'Unknown supplier.');
      elsif not v_supplier.active then
        v_problems := v_problems || jsonb_build_object('code', 'supplier_inactive', 'message', format('Supplier %s is inactive in Stock Control.', v_supplier.name));
      end if;
    end if;

    v_product_type_name := nullif(trim(coalesce(v_sup ->> 'product_type_name', '')), '');
    if v_product_type_name is not null then
      v_norm_target := lower(regexp_replace(v_product_type_name, '\s+', ' ', 'g'));
      select count(*), min(t.id::text)::uuid
        into v_match_count, v_product_type_id
        from outsourced_product_types t
       where t.active
         and lower(regexp_replace(t.name, '\s+', ' ', 'g')) = v_norm_target;
      if v_match_count <> 1 then
        v_product_type_id := null;
      end if;
    end if;
    if v_product_type_id is null and v_supplier.id is not null and v_supplier.default_product_type_id is not null then
      v_product_type_id := v_supplier.default_product_type_id;
      v_warnings := v_warnings || jsonb_build_object('code', 'product_type_defaulted', 'message',
        format('"%s" isn''t an active Stock Control product type — using %s''s default type instead.', coalesce(v_product_type_name, '(none)'), v_supplier.name));
    end if;
    if v_product_type_id is null then
      v_problems := v_problems || jsonb_build_object('code', 'product_type_unknown', 'message',
        format('"%s" doesn''t match an active Stock Control product type and the supplier has no default — fix the material''s product type on Admin → Outsourcing.', coalesce(v_product_type_name, '(none)')));
    end if;

    begin
      v_must_ship_by := nullif(v_sup ->> 'must_ship_by', '')::date;
    exception when others then
      v_warnings := v_warnings || jsonb_build_object('code', 'ship_by_invalid', 'message', 'Must-ship-by date could not be read — the supplier''s default lead time will be used.');
    end;
    if v_must_ship_by is not null and v_must_ship_by < current_date then
      v_warnings := v_warnings || jsonb_build_object('code', 'ship_by_past', 'message', format('Must-ship-by %s is in the past.', v_must_ship_by));
    end if;

    if v_number <> '' then
      select count(*) into v_match_count
        from outsourced_orders
       where trim(coalesce(customer_order_ref, '')) = v_number and status <> 'cancelled';
      if v_match_count > 0 then
        v_warnings := v_warnings || jsonb_build_object('code', 'ref_in_use', 'message',
          format('Stock Control already has %s live supplier job(s) under %s — fine for a multi-material order; check it isn''t a duplicate.', v_match_count, v_number));
      end if;
    end if;
  end if;

  if p_validate_only or jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object(
      'ok', jsonb_array_length(v_problems) = 0,
      'validate_only', p_validate_only,
      'already_imported', false,
      'problems', v_problems,
      'warnings', v_warnings,
      'resolution', jsonb_build_object(
        'customer', v_customer,
        'sc_material_id', v_sc_material_id,
        'sc_material_name', v_sc_material_name,
        'product_type_id', v_product_type_id
      )
    );
  end if;

  if v_pv_order is null then
    raise exception 'pv_order_id is required to execute a hand-off';
  end if;

  select status, handoff_at into v_status, v_handoff_at
    from proofs.orders where id = v_pv_order for update;
  if not found then
    raise exception 'proof-viewer order % not found', v_pv_order;
  end if;
  if v_handoff_at is not null then
    return jsonb_build_object(
      'ok', true, 'validate_only', false, 'already_imported', true,
      'problems', '[]'::jsonb, 'warnings', v_warnings,
      'resolution', jsonb_build_object('customer', v_customer, 'sc_material_id', v_sc_material_id, 'sc_material_name', v_sc_material_name, 'product_type_id', v_product_type_id)
    );
  end if;
  if v_status not in ('paid', 'revision') then
    raise exception 'order is % — not placeable', v_status;
  end if;

  if v_split_n >= 2 then
    select string_agg((e ->> 'name') || ' ' || (e ->> 'qty'), ', ')
      into v_split_text
      from jsonb_array_elements(v_split) e;
  end if;

  if v_route = 'in_house' then
    v_parts := array[]::text[];
    if v_is_prototype then
      v_parts := v_parts || format('PROTOTYPE SAMPLE — up to %s exact %s, NOT a production run.', v_qty, case when v_qty = 1 then 'copy' else 'copies' end);
    end if;
    -- Gilding reaches the workshop ONLY through this line (see the 000360
    -- header). String compare, not a ::boolean cast, so a malformed payload
    -- can never raise inside the placement transaction.
    if v_mat_code = 'paper_letterpress_gilded' or coalesce(v_lp ->> 'gilding', '') = 'true' then
      v_parts := v_parts || 'Gilded edges'::text;
    end if;
    if v_date_required is not null then
      v_parts := v_parts || ('Date required: ' || to_char(v_date_required, 'DD Mon YYYY'));
    end if;
    if nullif(trim(coalesce(p_payload -> 'inks' ->> 'front', '')), '') is not null then
      v_parts := v_parts || ('Ink on front: ' || trim(p_payload -> 'inks' ->> 'front'));
    end if;
    if nullif(trim(coalesce(p_payload -> 'inks' ->> 'back', '')), '') is not null then
      v_parts := v_parts || ('Ink on back: ' || trim(p_payload -> 'inks' ->> 'back'));
    end if;
    if nullif(trim(coalesce(p_payload ->> 'packaging', '')), '') is not null then
      v_parts := v_parts || ('Packaging: ' || trim(p_payload ->> 'packaging'));
    end if;
    if v_split_text is not null then
      v_parts := v_parts || ('Per person: ' || v_split_text);
    end if;
    if v_note is not null then
      v_parts := v_parts || ('Note: ' || regexp_replace(v_note, '\s*\n+\s*', ' / ', 'g'));
    end if;
    -- The prepped-artwork folder, so the job card is never left with no route to
    -- the files (see the 000360 header).
    if nullif(trim(coalesce(p_payload -> 'artwork' ->> 'dropbox_url', '')), '') is not null then
      v_parts := v_parts || ('Artwork: ' || trim(p_payload -> 'artwork' ->> 'dropbox_url'));
    end if;
    v_notes := nullif(array_to_string(v_parts, ' | '), '');

    if v_is_letterpress then
      v_line := jsonb_build_object(
        'front', v_lp ->> 'front', 'core', v_lp ->> 'core', 'back', v_lp ->> 'back',
        'quantity', v_qty
      );
    elsif v_sc_material_id is not null then
      v_line := jsonb_build_object('material_id', v_sc_material_id, 'quantity', v_qty);
    else
      -- 000383: only reachable in blanks mode (any other unresolved material
      -- stopped at the problems gate above). The job is created lineless.
      v_line := null;
    end if;

    select id into v_pre_existing
      from public.orders where inhouse_order_no = v_number and status <> 'cancelled';

    v_sc_order_id := create_inhouse_order_from_note(
      p_order_no => v_number,
      p_customer_name => v_customer,
      p_lines => case when v_line is null then '[]'::jsonb else jsonb_build_array(v_line) end,
      p_helpscout_conversation_id => v_conv,
      p_notes => v_notes,
      p_starts_local => null,
      p_ends_local => null,
      p_allow_no_lines => v_is_blanks
    );
    v_sc_order_table := 'orders';
    v_already := v_pre_existing is not null;
    if not v_already then
      update public.orders set import_source = 'direct'
       where id = v_sc_order_id and import_source is null;
    end if;

  else
    if v_must_ship_by is not null then
      v_ship := v_must_ship_by;
    elsif v_supplier.default_lead_days is not null then
      v_ship := current_date + v_supplier.default_lead_days;
    end if;
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

    v_parts := array[]::text[];
    if v_is_prototype then
      v_parts := v_parts || format('PROTOTYPE SAMPLE — up to %s exact %s, NOT a production run.', v_qty, case when v_qty = 1 then 'copy' else 'copies' end);
    end if;
    if nullif(concat_ws(' · ', nullif(trim(coalesce(v_sup ->> 'thickness', '')), ''), nullif(trim(coalesce(v_sup ->> 'finish', '')), '')), '') is not null then
      v_parts := v_parts || concat_ws(' · ', nullif(trim(coalesce(v_sup ->> 'thickness', '')), ''), nullif(trim(coalesce(v_sup ->> 'finish', '')), ''));
    end if;
    if v_split_text is not null then
      v_parts := v_parts || ('Per person: ' || v_split_text);
    end if;
    if v_note is not null then
      v_parts := v_parts || ('Note: ' || regexp_replace(v_note, '\s*\n+\s*', ' / ', 'g'));
    end if;
    -- The prepped-artwork folder, so the job card is never left with no route to
    -- the files (see the 000360 header).
    if nullif(trim(coalesce(p_payload -> 'artwork' ->> 'dropbox_url', '')), '') is not null then
      v_parts := v_parts || ('Artwork: ' || trim(p_payload -> 'artwork' ->> 'dropbox_url'));
    end if;
    v_notes := nullif(array_to_string(v_parts, ' | '), '');

    select id into v_pre_existing
      from outsourced_orders
     where trim(coalesce(customer_order_ref, '')) = v_number
       and supplier_id = v_supplier_id
       and quantity = v_supplier_qty
       and import_source = 'direct'
       and status <> 'cancelled'
       and created_at > now() - interval '14 days'
     order by created_at desc
     limit 1;

    if v_pre_existing is not null then
      v_sc_order_id := v_pre_existing;
      v_already := true;
    else
      insert into outsourced_orders (
        supplier_id, product_type_id, quantity, customer_name, customer_order_ref,
        supplier_is_international, expected_ship_date, expected_arrival_date,
        notes, helpscout_conversation_id, import_source
      )
      values (
        v_supplier_id, v_product_type_id, v_supplier_qty, v_customer, v_number,
        coalesce(v_supplier.is_international, false), v_ship, v_arrival,
        v_notes, null, 'direct'
      )
      returning id into v_sc_order_id;
    end if;
    v_sc_order_table := 'outsourced_orders';
  end if;

  update proofs.orders set
    status = 'fulfilled',
    fulfilled_at = now(),
    fulfilled_by = v_placed_by,
    order_spec_snapshot = coalesce(p_spec_snapshot, order_spec_snapshot),
    supplier_id = case when v_route = 'supplier' then v_supplier_id else supplier_id end,
    supplier_name = case when v_route = 'supplier' then v_supplier.name else supplier_name end,
    supplier_overs = case when v_route = 'supplier' then v_overs else supplier_overs end,
    handoff_at = now(),
    handoff_payload = p_payload,
    handoff_error = null,
    updated_at = now()
  where id = v_pv_order and status in ('paid', 'revision');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'order was no longer placeable (not paid/revision)';
  end if;

  return jsonb_build_object(
    'ok', true,
    'validate_only', false,
    'already_imported', v_already,
    'sc_order_table', v_sc_order_table,
    'sc_order_id', v_sc_order_id,
    'problems', '[]'::jsonb,
    'warnings', v_warnings,
    'resolution', jsonb_build_object(
      'customer', v_customer,
      'sc_material_id', v_sc_material_id,
      'sc_material_name', v_sc_material_name,
      'product_type_id', v_product_type_id,
      'expected_ship_date', v_ship
    )
  );
end;
$function$;

revoke all on function public.create_order_handoff(jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_order_handoff(jsonb, jsonb, boolean) to service_role;
