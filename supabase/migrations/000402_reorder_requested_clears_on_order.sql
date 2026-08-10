-- 000402: a reorder request can be answered ON the proof, not only by a child.
--
-- The reorder_requested chip (000373) clears on ONE thing: a child proof
-- carrying reorder_of_proof_id back to here. That is right for the ordinary
-- case -- a delivered customer asks again, "Raise the reorder" duplicates the
-- project, and the reorder becomes its own job.
--
-- It is wrong for an OUTREACH proof (Reorder desk, 000389). That proof IS
-- already the new project: born in_progress with artwork and no order row, so
-- the designer's next move is to approve it and sell from it, never to
-- duplicate it. Left alone, the chip would nag forever, and the button it
-- points at would mint an unapproved duplicate (duplicateProof pre-approves
-- only when the SOURCE is approved and has approval rows to carry -- an
-- outreach proof is neither) and strand the real work on the wrong proof.
--
-- So the rr CTE gains a SECOND clear condition, OR-ed with the child test.
-- Everything else in the function is byte-identical -- enforced below, not
-- promised.
--
-- Read-only verification performed before authoring (2026-08-10, live):
--   * old rr vs new rr over live: EXCEPT both ways = 0 rows, both totals 0.
--     Zero proofs change classification today (0 rows carry
--     reorder_requested_at), and rr is the only branch touched, so the whole
--     function's output is unchanged. Baseline to re-check after apply:
--       select count(*) from proofs.proofs_needing_attention();            -- 20
--       select md5(string_agg(proof_id::text||'|'||rule_code, ','
--                  order by proof_id::text))
--         from proofs.proofs_needing_attention();
--       -- c5696f50e4f86a91b549a1aa2be0676d
--   * the time anchor, against 212 real production orders: pretending the
--     request landed one day BEFORE each order, 212/212 clear (the order
--     answers it); pretending it landed one day AFTER, 0/212 clear (an old
--     order is not an answer). That direction is the point of the change.
--   * proofs.orders is readable by every designer -- policy orders_rw is
--     FOR ALL TO authenticated USING (true) -- so adding this read to a
--     SECURITY INVOKER function cannot make the chip clear for admins and nag
--     for designers (the 000376 trap). ano already reads the same table here.
--
-- ⚠ WHY THIS IS A GUARDED SERVER-SIDE REPLACE AND NOT A RE-EMIT. This is the
-- schema's most drift-prone function (000188/000208/000217/000221/000246/
-- 000307/000308/000373/000381 plus at least one live edit that matches NO file
-- in this repo), and hand-retyping ~400 lines of it is exactly the failure this
-- house has had before. The guard makes byte-identity a database-enforced
-- precondition: the pre-md5 must match what was read, the block must be found
-- exactly once, and the patched body must hash to the value computed
-- read-only. Any drift between authoring and apply aborts the transaction
-- rather than shipping a silent regression. If the pre-md5 fails, live has
-- moved: re-read pg_get_functiondef and re-derive. Do NOT delete the guard to
-- make it apply.

do $mig$
declare
  v_src  text;
  v_old  text;
  v_new  text;
  v_body text;
  c_pre  constant text := '06e1895c247da7cc6ddcc387a6b64eae';
  c_post constant text := '7b2726b4bada56ccc6122428a9a8401f';
begin
  select p.prosrc into v_src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'proofs' and p.proname = 'proofs_needing_attention';

  if v_src is null then
    raise exception '000402: proofs.proofs_needing_attention() not found';
  end if;

  -- Pin the body this patch was derived from. If live has moved on, STOP:
  -- re-read pg_get_functiondef and re-derive, exactly as the house rule says.
  if md5(v_src) <> c_pre then
    raise exception
      '000402: live body md5 % does not match the % this migration was written against; re-read pg_get_functiondef and re-derive the patch',
      md5(v_src), c_pre;
  end if;

  v_old :=
$old$  rr as (
    select p.id as proof_id,
      p.reorder_request_quantity as quantity,
      (extract(epoch from now() - p.reorder_requested_at)::int) / 86400 as days
    from proofs p
    where p.reorder_requested_at is not null
      and p.status <> 'abandoned'
      and not exists (
        select 1 from proofs child
        where child.reorder_of_proof_id = p.id
      )
  ),
$old$;

  v_new :=
$new$  rr as (
    select p.id as proof_id,
      p.reorder_request_quantity as quantity,
      (extract(epoch from now() - p.reorder_requested_at)::int) / 86400 as days
    from proofs p
    where p.reorder_requested_at is not null
      and p.status <> 'abandoned'
      and not exists (
        select 1 from proofs child
        where child.reorder_of_proof_id = p.id
      )
      -- 000402: the OTHER way a request gets answered — an order raised on
      -- THIS proof after the customer asked for it.
      --
      -- An outreach proof (Reorder desk, 000389) IS already the new project.
      -- It is born in_progress with artwork and NO order row, so the answer to
      -- "please make me more" is to approve it and sell from it, never to
      -- duplicate it into a child. Without this the chip nags forever, and the
      -- button it points at mints an unapproved duplicate and strands it.
      --
      -- ⚠ Anchored to the request time, and that anchor is the whole safety
      -- story. A bare "an order exists" would clear on the order the customer
      -- ALREADY had — which on a delivered proof is the very order the reorder
      -- panel offers a repeat of (000372 shows the panel only once a paid
      -- order has been dispatched or delivered), so every genuine request
      -- would clear the instant it was made. claim_reorder_request re-stamps
      -- reorder_requested_at = now() on each new ask, so this re-arms if the
      -- same customer comes back years later.
      --
      -- production only: a free reprint (000295) and an internal prototype
      -- (000287) each write an order row on this same proof, and neither is an
      -- answer to "sell me more".
      --
      -- The status test is byte-identical to the ano CTE above — this
      -- codebase's single definition of "a real pay link went out", including
      -- that a cancelled order counts only if it was actually sent. Bare
      -- `orders` matches ano and resolves through this function's pinned
      -- search_path (proofs before public, where a DIFFERENT orders table
      -- lives).
      --
      -- Deliberately NOT status = 'approved'. In the ordinary case the source
      -- proof is already approved before the customer can even ask, so that
      -- test would clear every request on arrival; and a designer's "Mark as
      -- approved" is tidying up, not a sale.
      and not exists (
        select 1 from orders o
        where o.proof_id = p.id
          and o.order_kind = 'production'
          and o.created_at >= p.reorder_requested_at
          and (o.status in ('sent', 'paid', 'fulfilled', 'revision')
               or (o.status = 'cancelled' and o.sent_at is not null))
      )
  ),
$new$;

  if (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 then
    raise exception '000402: the rr CTE was not found exactly once in the live body';
  end if;

  v_body := replace(v_src, v_old, v_new);

  -- Proves the result is live-with-only-rr-changed. Computed read-only against
  -- live before this file was written.
  if md5(v_body) <> c_post then
    raise exception '000402: patched body md5 % <> expected %', md5(v_body), c_post;
  end if;

  -- Header restated exactly as live has it: plpgsql, STABLE, SECURITY INVOKER
  -- (prosecdef = false), search_path pinned.
  execute format(
    'create or replace function proofs.proofs_needing_attention()'
    ' returns table(proof_id uuid, rule_code text, rule_meta jsonb)'
    ' language plpgsql'
    ' stable'
    ' set search_path to ''proofs'', ''public'', ''extensions'', ''pg_temp'''
    ' as $fn$%s$fn$', v_body);
end
$mig$;

-- Grants restated to match live exactly. create-or-replace preserves the ACL,
-- so this is a no-op today; it is here because the proofs schema has no
-- pg_default_acl for functions and an omitted revoke is how a function becomes
-- callable from the public internet (the 000356 lesson).
revoke execute on function proofs.proofs_needing_attention() from public, anon;
grant  execute on function proofs.proofs_needing_attention() to authenticated, service_role;

-- Post-apply check (read-only):
--   select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='proofs' and p.proname='proofs_needing_attention';
--   -- expect 7b2726b4bada56ccc6122428a9a8401f  (length 20416)
