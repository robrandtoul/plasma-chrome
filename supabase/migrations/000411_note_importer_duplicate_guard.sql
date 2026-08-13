-- 000411: stop the legacy note importer re-importing a job proof-viewer has
-- already placed directly.
--
-- ⚠ TARGET: the merged stock-control project (bjvinrzbdrwebylkmbwy). Apply via
-- MCP apply_migration or the dashboard SQL editor — NOT `supabase db push`.
--
-- APPLIED to live 2026-08-13 via MCP apply_migration, and verified there:
--   · the non-guard body still hashes md5 851c9ac2dc1f78b4431f43bf99998db8 over
--     5000 chars, i.e. the apply changed nothing but the guard
--   · owner, ACL ({postgres=X,service_role=X}), SECURITY DEFINER, search_path
--     and the identity signature are all unchanged
--   · replaying the real re-import (order 404004, letterpress x1000, HS 3403609629)
--     RAISES naming job 404001, and writes nothing
--   · positive control: a genuinely different job on that SAME thread (wood x500)
--     is NOT blocked and creates normally
-- Both live tests ran inside a DO block ending in an exception, so each rolled
-- back; 160 in-house jobs before and after.
--
-- ── WHAT HAPPENED (13 Aug 2026, Brownies Tree, HS conversation 3403609629) ──
--
-- Three orders were placed together as one combined payment. place-order wrote
-- in-house job 404001 directly (import_source 'direct') at 13:01:15 and, as it
-- always does, posted the human-readable production note on the customer's
-- Help Scout thread at 13:01:19. Eighty-three seconds later a SECOND in-house
-- job appeared for the same 1000 letterpress cards — created by THIS function,
-- from THAT note, and numbered 404004, which by then belonged to the sibling
-- Solopress standard-paper order placed 35 seconds after the first.
--
-- Provenance is not inferred. Of the three functions that create an in-house
-- order, this is the only one that leaves created_by NULL while writing BOTH
-- notes and lines (create_inhouse_order stamps auth.uid() and is role-gated;
-- create_finishing_order is role-gated and writes finishing_quantity with no
-- lines). And the phantom's notes carry "03 Sept 2026" and "(ship with wood and
-- matt lams)" verbatim from the 13:01:19 note — tokens that appear nowhere in
-- 404001's own row, because those two notes are written by different composers.
-- No human is implicated.
--
-- ⚠ WHERE THE NUMBER 404004 CAME FROM IS A HYPOTHESIS, NOT A FINDING.
-- p_order_no is supplied by the caller, and the caller is Stock Control code we
-- cannot read from this repo. The likeliest story is that it derives from the
-- Help Scout conversation subject, which place-order renames on every placement
-- — so the supplier placement 35 seconds later overwrote "Order 404001 …" with
-- "Order 404004 …". That is consistent with the evidence but unproved, so this
-- migration deliberately does NOT change the note format or the rename. It
-- closes the hole at the point of insertion, where the evidence is certain.
--
-- ── WHY ALL THREE EXISTING DEDUPE LAYERS MISSED ─────────────────────────────
--
-- Every one of them is keyed on the ORDER NUMBER: layer 1 on inhouse_order_no,
-- layer 2 (the adopt branch) on conversation + an order_ref regex + a NULL
-- inhouse_order_no, layer 3 on unique_violation. The direct row already carried
-- inhouse_order_no '404001', so a note arriving as '404004' missed all three.
-- The number is exactly the thing that was wrong, so no number-keyed check can
-- ever catch this. The guard below keys on the WORK instead.
--
-- ── WHY NOT A TRIGGER ON public.orders ──────────────────────────────────────
--
-- Three independent reasons, any one sufficient:
--   1. It cannot work. What separates this accident from legitimate work is the
--      material + quantity, and order_lines do not exist yet at BEFORE INSERT.
--   2. The only predicate available at that moment is the conversation, which
--      would block the wood order 404005 — paid and awaiting placement on this
--      very conversation. Several cards on one thread is the normal shape here.
--   3. public.orders is Stock Control's primary write path, and 131 of its 161
--      jobs never came from proof-viewer. A false raise there is a colleague
--      unable to enter an order, from software they have never heard of.
--
-- ⚠ THE DIRECT HAND-OFF REACHES THIS FUNCTION TOO, AND IS STOOD DOWN HERE.
-- public.create_order_handoff calls create_inhouse_order_from_note for the
-- in_house route (verified on live: the call sits at prosrc byte 18600), so
-- this is NOT the legacy path's private function. Worse, that function's
-- `p_validate_only` early return is at byte 14495 — BEFORE the call — so the
-- guard cannot appear in OrderReviewPage's preview and would surface for the
-- first time at Confirm, on a PAID order, with nothing shown beforehand. Two
-- in-house cards of the same material and quantity on one Help Scout thread
-- within 24h is an ordinary bundle/combined-payment shape, so this would have
-- refused real placements. (Zero such pairs exist on live today, which is
-- exactly why it would have shipped unnoticed.)
--
-- The guard therefore runs ONLY when it can positively establish it is not on
-- the direct path, by reading the plpgsql call stack. It FAILS OPEN: if the
-- stack is unreadable, or names create_order_handoff, the guard stands down and
-- behaviour is byte-identical to today. A guard that goes quiet is the status
-- quo; a guard that blocks a paid order is a new outage.
--
-- The alternative — a transaction-local flag set by create_order_handoff — was
-- rejected because it means re-emitting that 23KB function, the single most
-- load-bearing thing in the ordering pipeline, to add one line. If the guard is
-- ever wanted on the direct path too, it must NOT raise there: it has to come
-- back as a `problems` entry so it shows in the validate-only preview, per the
-- rule the shadow-mode copy incident established (memory:handoff-checks-blocking-copy).
--
-- ── WHY NOT A UNIQUE CONSTRAINT ON THE ORDER NUMBER ─────────────────────────
--
-- 12 legitimate hybrid jobs intentionally carry the same ref in public.orders
-- AND public.outsourced_orders (supplier makes the blanks, we finish them), and
-- split supplier batches repeat a ref within outsourced_orders. A cross-table
-- uniqueness rule would block every one of them. 404004 was the only ref ever
-- to wear the hybrid shape without being one.
--
-- ── THE PREDICATE, AND WHY IT RAISES RATHER THAN RETURNS ────────────────────
--
--   same conversation      — the duplicate is always on the thread we posted to
--   identical line SET     — full ordered set equality, never "any line matches
--                            any line": one conversation legitimately carries
--                            several cards, and an any-match test would swallow
--                            the second one
--   sibling is 'direct'    — this is about OUR failure mode; two legacy jobs on
--                            one thread are Stock Control's own business
--   within 24 hours        — forward cover, not a live constraint. Two genuine
--                            REPRINT pairs share thread + material + quantity
--                            (102.6h and 224.5h apart), but the earlier row of
--                            each is legacy, so the 'direct' clause already
--                            excludes them: removing the window changes nothing
--                            on today's data. It is kept because reprints now DO
--                            go through the direct route (order_kind='reprint'
--                            exists on live), which is when it starts mattering.
--   different number       — a matching number already returned at layer 1, and
--                            that is success, not a fault
--
-- ⚠ import_source is nullable with no default and today holds only 'direct'
-- (30 rows) or NULL (130). If Stock Control ever stamps a third value of its
-- own, this predicate silently NARROWS rather than widening — the guard goes
-- quiet, it does not start over-firing. Stated so the assumption is visible.
--
-- It RAISES rather than returning the existing id, unlike the two branches
-- above it. Those both hand back an order that genuinely carries p_order_no —
-- layer 1 matches on it, layer 2 stamps it before returning. Returning here
-- would be the first branch ever to hand back an order whose inhouse_order_no
-- is a DIFFERENT number, so the caller would record the letterpress job as
-- "the job for 404004" and every later stamp would land on the wrong row. A
-- silently-missing job is also worse than a duplicate: a duplicate is caught at
-- scheduling, a missing job is caught by the customer.
--
-- Validated read-only against all 161 in-house orders before authoring: fires
-- on exactly one, the incident (404004, naming 404001, 1.5 minutes apart), and
-- on none of the reprints, repeats, hybrids, finishing legs, split batches, the
-- same-second Woolridge pair, or the pending wood order 404005.
--
-- Body is a verbatim copy of the LIVE pg_get_functiondef read on 13 Aug 2026,
-- with only the guard block and its three declares added — live has drifted
-- from the migration files before (see the 000383 header), so it must never be
-- rebuilt from those. CREATE OR REPLACE, signature unchanged, so the owner and
-- the service_role ACL are preserved and p_allow_no_lines (000383) survives.
--
-- Verified mechanically, not by reading: strip this file's guard block and the
-- v_insig / v_dup_ref / v_ctx declares, and the remainder hashes
-- md5 851c9ac2dc1f78b4431f43bf99998db8 over 5000 chars — identical to the live
-- body (prosrc lines 2..134; note btrim() strips spaces, NOT the newlines the
-- stored body is wrapped in, which is why a naive btrim comparison is off by 2).
-- Redo that check before any future re-emit.

create or replace function public.create_inhouse_order_from_note(
  p_order_no text,
  p_customer_name text,
  p_lines jsonb,
  p_helpscout_conversation_id bigint,
  p_notes text default null::text,
  p_starts_local text default null::text,
  p_ends_local text default null::text,
  p_allow_no_lines boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order_id uuid;
  v_count    int;
  v_line     jsonb;
  v_qty      int;
  v_material uuid;
  v_start    timestamptz;
  v_end      timestamptz;
  v_insig    text;
  v_dup_ref  text;
  v_ctx      text;
begin
  if p_order_no is null or btrim(p_order_no) = '' then
    raise exception 'An order number is required';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Lines must be a JSON array';
  end if;

  -- Idempotency: a re-fired webhook for the same number returns the existing
  -- row. Cancelled orders are ignored so a number can be re-imported after a
  -- cancel (the partial unique index excludes cancelled to match).
  select id into v_order_id
    from orders
   where inhouse_order_no = btrim(p_order_no)
     and status <> 'cancelled';
  if v_order_id is not null then
    return v_order_id;
  end if;

  -- Adopt a hand-entered order. Staff sometimes key the job in as an ordinary
  -- customer order before the importer sees it, leaving inhouse_order_no NULL,
  -- so the lookup above misses it. Match a live order on the same Help Scout
  -- thread whose order_ref carries this order number, claim it, and return it
  -- rather than inserting a duplicate.
  if p_helpscout_conversation_id is not null then
    update orders o
       set inhouse_order_no = btrim(p_order_no),
           customer_name    = coalesce(o.customer_name,
                                       nullif(btrim(coalesce(p_customer_name, '')), '')),
           notes            = coalesce(o.notes,
                                       nullif(btrim(coalesce(p_notes, '')), ''))
     where o.id = (
             select id
               from orders
              where helpscout_conversation_id = p_helpscout_conversation_id
                and inhouse_order_no is null
                and status <> 'cancelled'
                and order_ref ~ ('(^|\D)' || btrim(p_order_no) || '($|\D)')
              order by created_at
              limit 1
           )
    returning o.id into v_order_id;
    if v_order_id is not null then
      return v_order_id;   -- adopted: lines/schedule already belong to this order
    end if;
  end if;

  -- Validate every line up front: a positive quantity, and either a
  -- material_id or a full letterpress front/core/back.
  v_count := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_line ->> 'quantity')::int, 0) <= 0 then
      raise exception 'Each line needs a positive quantity in cards';
    end if;
    if (v_line ->> 'material_id') is null
       and (
         (v_line ->> 'front') is null
         or (v_line ->> 'core') is null
         or (v_line ->> 'back') is null
       )
    then
      raise exception 'Each line needs a material_id or a letterpress front/core/back';
    end if;
    v_count := v_count + 1;
  end loop;
  -- A lineless job is allowed ONLY when the caller says so (000383): a
  -- blanks-source finishing job works supplier-made blanks, which aren't sheet
  -- stock to allocate — the same shape staff already hand-key. Every other
  -- caller keeps the guard exactly as it was.
  if v_count = 0 and not p_allow_no_lines then
    raise exception 'At least one line is required';
  end if;

  -- ── 000411 GUARD: this job is already in Stock Control ────────────────────
  -- The work-keyed check the three number-keyed layers above cannot make. See
  -- the migration header for why it raises, why each clause is load-bearing,
  -- and why it must never run on the direct hand-off path.
  --
  -- A lineless import is skipped deliberately: with no lines there is nothing to
  -- compare, and lineless IS the legitimate hybrid-finishing shape.
  if p_helpscout_conversation_id is not null and v_count > 0 then
    -- Which caller are we under? create_order_handoff reaches this function for
    -- every in-house placement, and must never be blocked. Fail open: any doubt
    -- — an empty stack, an unexpected format — stands the guard down.
    begin
      get diagnostics v_ctx = pg_context;
    exception when others then
      v_ctx := null;
    end;

    if v_ctx is not null and v_ctx not like '%create_order_handoff%' then
      -- Cheapest discriminator first. Only if a candidate sibling exists is it
      -- worth resolving the incoming lines — _resolve_letterpress_combo is NOT
      -- read-only (it inserts an unseen combo and un-archives an archived one),
      -- so it must not run on every ordinary import just to build a key.
      if exists (
        select 1 from orders o
         where o.helpscout_conversation_id = p_helpscout_conversation_id
           and o.status <> 'cancelled'
           and o.import_source = 'direct'
           and o.created_at > now() - interval '24 hours'
           and btrim(coalesce(o.inhouse_order_no, '')) is distinct from btrim(p_order_no)
      ) then
        -- Resolve the incoming lines to the same (material, quantity) shape the
        -- stored rows carry. Wrapped: if a combo cannot be resolved the
        -- signature is abandoned and the guard stands down, leaving the original
        -- code path — and its own error, below — unchanged.
        begin
          select string_agg(s.mid::text || ':' || s.qty, '|' order by s.mid::text, s.qty)
            into v_insig
            from (
              select case
                       when (e ->> 'material_id') is not null then (e ->> 'material_id')::uuid
                       else _resolve_letterpress_combo(e ->> 'front', e ->> 'core', e ->> 'back')
                     end as mid,
                     (e ->> 'quantity')::int as qty
                from jsonb_array_elements(p_lines) e
            ) s;
        exception when others then
          v_insig := null;
        end;

        if v_insig is not null then
          select o.order_ref into v_dup_ref
            from orders o
           where o.helpscout_conversation_id = p_helpscout_conversation_id
             and o.status <> 'cancelled'
             and o.import_source = 'direct'
             and o.created_at > now() - interval '24 hours'
             and btrim(coalesce(o.inhouse_order_no, '')) is distinct from btrim(p_order_no)
             and (select string_agg(l.material_id::text || ':' || l.quantity, '|'
                                    order by l.material_id::text, l.quantity)
                    from order_lines l where l.order_id = o.id) = v_insig
           order by o.created_at
           limit 1;

          if v_dup_ref is not null then
            raise exception
              'This job is already in Stock Control as job % — it was placed directly from the proof viewer, and this note is a copy of it. Nothing has been created, and re-sending the note will not help. If % is genuinely a separate job, it needs a different order number.',
              v_dup_ref, btrim(p_order_no);
          end if;
        end if;
      end if;
    end if;
  end if;
  -- ── end 000411 guard ─────────────────────────────────────────────────────

  begin
    insert into orders (order_ref, inhouse_order_no, customer_name,
                        helpscout_conversation_id, notes)
    values (
      btrim(p_order_no),
      btrim(p_order_no),
      nullif(btrim(coalesce(p_customer_name, '')), ''),
      p_helpscout_conversation_id,
      nullif(btrim(coalesce(p_notes, '')), '')
    )
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id
      from orders
     where inhouse_order_no = btrim(p_order_no)
       and status <> 'cancelled';
    return v_order_id;
  end;

  -- Insert each line, resolving letterpress combos to a tracked material so
  -- the order allocates against it.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::int;
    if (v_line ->> 'material_id') is not null then
      v_material := (v_line ->> 'material_id')::uuid;
    else
      v_material := _resolve_letterpress_combo(
        v_line ->> 'front', v_line ->> 'core', v_line ->> 'back'
      );
    end if;
    insert into order_lines (order_id, material_id, quantity)
    values (v_order_id, v_material, v_qty);
  end loop;

  -- Optional first block from a Schedule: line (London wall-clock). Bad text
  -- is ignored rather than failing the import.
  if p_starts_local is not null and p_ends_local is not null then
    begin
      v_start := timezone('Europe/London', p_starts_local::timestamp);
      v_end   := timezone('Europe/London', p_ends_local::timestamp);
    exception when others then
      v_start := null;
      v_end   := null;
    end;
    if v_start is not null and v_end is not null and v_end > v_start then
      insert into production_blocks (order_id, starts_at, ends_at)
      values (v_order_id, v_start, v_end);
    end if;
  end if;

  return v_order_id;
end;
$function$;

comment on function public.create_inhouse_order_from_note(text, text, jsonb, bigint, text, text, text, boolean) is
  'Legacy Help Scout note importer for in-house jobs. Carries the 000411 work-keyed guard: refuses to create a job whose exact line set already exists as a directly-placed job on the same conversation within 24h. Any re-emit must keep that guard and p_allow_no_lines (000383), and must be authored from the LIVE definition, not from the migration files.';
