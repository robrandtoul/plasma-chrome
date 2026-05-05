-- Migration 000137: bulk-import RPC for letterpress_core_colours.
--
-- Backs the XLSX round-trip flow on /admin/core-colours: client
-- exports the catalogue to a spreadsheet, designer edits in Excel
-- (or similar), client re-imports the file, computes a preview,
-- and on Apply calls this RPC. The RPC is the single
-- transactional commit point — preview/diff is a UI affordance,
-- not a separate DB step.
--
-- Server-side responsibilities:
--   * Validate every row independently (hex regex, name non-empty,
--     sort_order integer, is_active boolean) and across the whole
--     batch (no duplicate names within the import). Defence in
--     depth alongside the client validation; protects against
--     anyone calling the RPC directly with a hand-crafted payload.
--   * Apply id-bearing rows as UPDATEs, error if id missing.
--   * Apply id-less rows as INSERTs, with ON CONFLICT (name) DO
--     UPDATE so a name typed twice with different uuids still
--     converges on a single row.
--   * Soft-deactivate any row whose id is absent from the import.
--     Hard delete is forbidden by the on-delete-restrict FK on
--     proof_versions and would lose history; soft-delete keeps
--     existing proofs rendering and just removes the colour from
--     designer pickers (the "is_active = true" RLS filter handles
--     that).
--   * Write one audit_log row capturing the operation outcome.
--     before_value carries the previous active count;
--     after_value carries new active count + per-bucket counts +
--     source filename.
--
-- Returns a jsonb summary so the client can show a toast with
-- the same numbers it just previewed.
--
-- Empty input is an error, not a "deactivate everything" pass.
-- Mistakes from an accidentally-empty spreadsheet would otherwise
-- silently retire the whole catalogue.
--
-- RLS on letterpress_core_colours stays the gate for write
-- privileges. The function is SECURITY INVOKER (default) so
-- non-admin callers will fail on the underlying UPDATE/INSERT
-- regardless of the EXECUTE grant.

begin;

create or replace function apply_core_colours_import(
  rows             jsonb,
  source_filename  text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_row              jsonb;
  v_id               uuid;
  v_name             text;
  v_hex              text;
  v_sort             int;
  v_active           boolean;
  v_index            int := 0;
  v_inserted         int := 0;
  v_updated          int := 0;
  v_deactivated      int := 0;
  v_previous_active  int;
  v_new_active       int;
  v_kept_ids         uuid[] := array[]::uuid[];
  v_seen_names       text[] := array[]::text[];
  v_existing_id      uuid;
  v_pre_existed      boolean;
  v_actor_email      text;
begin
  -- Empty / non-array input → error rather than the "deactivate
  -- everything" disaster path.
  if rows is null or jsonb_typeof(rows) <> 'array' then
    raise exception 'apply_core_colours_import: rows must be a non-null jsonb array';
  end if;
  if jsonb_array_length(rows) = 0 then
    raise exception 'apply_core_colours_import: rows is empty (0 data rows). Refusing to deactivate the whole catalogue from an empty import.';
  end if;

  -- Snapshot before-state for audit.
  select count(*) filter (where is_active) into v_previous_active
    from letterpress_core_colours;

  -- ── Pass 1: per-row + cross-row validation ─────────────────────
  for v_row in select * from jsonb_array_elements(rows) loop
    v_index := v_index + 1;

    -- name (required, trimmed, non-empty)
    v_name := nullif(btrim(coalesce(v_row->>'name', '')), '');
    if v_name is null then
      raise exception 'apply_core_colours_import: row % has empty name', v_index;
    end if;

    -- duplicate name within import → error (same name twice would
    -- race the unique constraint and silently drop one)
    if v_name = any(v_seen_names) then
      raise exception 'apply_core_colours_import: duplicate name "%" in import (row %)', v_name, v_index;
    end if;
    v_seen_names := array_append(v_seen_names, v_name);

    -- hex (required, regex)
    v_hex := coalesce(v_row->>'hex_value', '');
    if v_hex !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'apply_core_colours_import: row % ("%") has invalid hex value "%". Expected 6-digit hex like #1B3A6B.', v_index, v_name, v_hex;
    end if;

    -- sort_order (required, integer)
    begin
      v_sort := (v_row->>'sort_order')::int;
    exception when others then
      raise exception 'apply_core_colours_import: row % ("%") has non-integer sort_order "%"', v_index, v_name, v_row->>'sort_order';
    end;

    -- is_active (required, boolean)
    if v_row->'is_active' is null then
      raise exception 'apply_core_colours_import: row % ("%") missing is_active', v_index, v_name;
    end if;
    if jsonb_typeof(v_row->'is_active') <> 'boolean' then
      raise exception 'apply_core_colours_import: row % ("%") has non-boolean is_active', v_index, v_name;
    end if;

    -- id, if present, must parse as uuid
    if v_row ? 'id' and v_row->'id' is not null and jsonb_typeof(v_row->'id') <> 'null' then
      begin
        v_id := (v_row->>'id')::uuid;
      exception when others then
        raise exception 'apply_core_colours_import: row % ("%") has invalid uuid "%"', v_index, v_name, v_row->>'id';
      end;
    end if;
  end loop;

  -- ── Pass 2: apply each row ─────────────────────────────────────
  -- Counts are kept simple: a row with an id is always an UPDATE
  -- (errors if the id doesn't exist); a row without an id is an
  -- INSERT or an UPDATE depending on whether a row with that name
  -- already existed before this RPC call. The pre-fetch is the
  -- definitive signal — ON CONFLICT branches both return the
  -- same RETURNING shape, so that's the only way to tell.
  v_index := 0;
  for v_row in select * from jsonb_array_elements(rows) loop
    v_index := v_index + 1;

    v_name   := btrim(v_row->>'name');
    v_hex    := lower(v_row->>'hex_value');
    v_sort   := (v_row->>'sort_order')::int;
    v_active := (v_row->>'is_active')::boolean;
    v_id     := null;
    if v_row ? 'id' and v_row->'id' is not null and jsonb_typeof(v_row->'id') <> 'null' then
      v_id := (v_row->>'id')::uuid;
    end if;

    if v_id is not null then
      -- id-bearing row: update by id (errors if not found).
      update letterpress_core_colours
         set name       = v_name,
             hex_value  = v_hex,
             sort_order = v_sort,
             is_active  = v_active,
             updated_at = now()
       where id = v_id;
      if not found then
        raise exception 'apply_core_colours_import: row % ("%") references id % which does not exist', v_index, v_name, v_id;
      end if;
      v_updated := v_updated + 1;
      v_kept_ids := array_append(v_kept_ids, v_id);
    else
      -- id-less row: classify by pre-existence (name lookup before
      -- the upsert), then upsert. The pre-fetch gives us the
      -- definitive insert vs update signal — ON CONFLICT branches
      -- both return identical RETURNING shape, so this is the only
      -- way to count accurately.
      select id into v_existing_id
        from letterpress_core_colours
       where name = v_name;
      v_pre_existed := v_existing_id is not null;

      insert into letterpress_core_colours (name, hex_value, sort_order, is_active)
        values (v_name, v_hex, v_sort, v_active)
        on conflict (name) do update
          set hex_value  = excluded.hex_value,
              sort_order = excluded.sort_order,
              is_active  = excluded.is_active,
              updated_at = now()
        returning id into v_existing_id;

      if v_existing_id is null then
        -- Defensive: RETURNING from an upsert always yields a row.
        raise exception 'apply_core_colours_import: failed to upsert row % ("%")', v_index, v_name;
      end if;

      if v_pre_existed then
        v_updated := v_updated + 1;
      else
        v_inserted := v_inserted + 1;
      end if;

      v_kept_ids := array_append(v_kept_ids, v_existing_id);
    end if;
  end loop;

  -- ── Pass 3: soft-deactivate anything not in the kept-set ───────
  -- Only flips is_active=true → false. Rows that were already
  -- inactive (and absent from the import) stay inactive without
  -- the count being inflated.
  with deactivated as (
    update letterpress_core_colours
       set is_active  = false,
           updated_at = now()
     where is_active = true
       and id <> all(v_kept_ids)
    returning id
  )
  select count(*) into v_deactivated from deactivated;

  -- ── Audit log ──────────────────────────────────────────────────
  -- actor_email read from the JWT claims when the call comes from
  -- an authenticated session; falls back to NULL when called from
  -- the SQL editor or a service-role context.
  begin
    v_actor_email := nullif(current_setting('request.jwt.claims', true)::jsonb->>'email', '');
  exception when others then
    v_actor_email := null;
  end;

  select count(*) filter (where is_active) into v_new_active
    from letterpress_core_colours;

  insert into audit_log (
    actor_id, actor_email, actor_label,
    action,
    target_type, target_label,
    before_value, after_value
  )
  values (
    auth.uid(),
    v_actor_email,
    coalesce(v_actor_email, 'system'),
    'core_colours_bulk_import',
    'letterpress_core_colours_table',
    'letterpress_core_colours',
    jsonb_build_object('previous_active_count', v_previous_active),
    jsonb_build_object(
      'new_active_count',  v_new_active,
      'inserted',          v_inserted,
      'updated',           v_updated,
      'deactivated',       v_deactivated,
      'source_filename',   source_filename
    )
  );

  return jsonb_build_object(
    'inserted',    v_inserted,
    'updated',     v_updated,
    'deactivated', v_deactivated
  );
end;
$$;

-- SECURITY INVOKER (default): the function runs with the caller's
-- privileges, so RLS on letterpress_core_colours gates writes. A
-- non-admin authenticated user gets EXECUTE on the function but
-- the underlying UPDATE/INSERT will fail their RLS check, which
-- bubbles up as a clear permission error.
grant execute on function apply_core_colours_import(jsonb, text) to authenticated;

commit;
