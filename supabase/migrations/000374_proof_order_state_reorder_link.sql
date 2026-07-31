-- 000374 — the old proof page points forward to the reorder it produced.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- The customer proof page is the URL customers bookmark — it's in every proof
-- email, it survives, and since 000371 it answers "where are my cards?" too.
-- A reorder raised from it turns that bookmark into a dead end: the page they
-- return to keeps describing a delivery from two years ago while the project
-- that actually matters is at a URL they were sent once and may have lost.
--
-- One new key on public_get_proof_order_state, so the old page can say "you
-- reordered these on 12 August — follow that order here" and become a hub
-- rather than an archive. The DATE it says comes from reorder_requested_at,
-- which 000372 already returns; only the destination is new.
--
-- ── When the link may appear ────────────────────────────────────────────────
-- NOT simply "a child proof exists". A designer raising a reorder may be
-- mid-build for hours — a half-uploaded project with one side of the artwork
-- on it is not something to hand a customer, and they'd arrive at it with no
-- covering message. The child is only named once it is either:
--
--   * approved — the pre-approved identical-reorder route, where there is no
--     proof round at all and nothing to wait for; or
--   * sent — its current version carries send evidence, meaning a designer has
--     deliberately put it in front of the customer.
--
-- Abandoned children are never named. A designer who scraps a reorder should
-- not have the source page still pointing at it.
--
-- ── On exposing another proof's id ──────────────────────────────────────────
-- 000367's rule for this page is "fact, not capability", and a proof id IS a
-- capability — /p/ has no token, so whoever holds the id can open the page.
-- It's granted here deliberately and narrowly: the destination is the same
-- customer's own reorder of their own artwork, raised from their own request,
-- and it is the exact link we would email them anyway. The two guards above
-- are what keep that true — without them this would hand out a capability
-- over work in progress, which is a different thing entirely.
--
-- Note this is the ONE outward pointer. The child's price, order state,
-- quantity and status stay unexposed; the source page links, it doesn't
-- report.

-- Body verbatim from live pg_get_functiondef (2026-07-31, the 000372
-- definition) with the `pr` lateral widened and one key appended. Re-emitted
-- from live rather than from 000372's file text — 000363's header records the
-- trap of rebuilding one of these from an older file and silently dropping a
-- sibling migration's work.
create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at,
      o.stock_order_number,
      o.status as own_status
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ),
  ranked as (
    select
      r.*,
      case
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        else null
      end as state
    from resolved r
  ),
  -- This ranking also makes the "no live unpaid link" half of the reorder gate
  -- free: a live link outranks a past payment, so state='paid' already implies
  -- nothing is outstanding.
  winner as (
    select *
    from ranked
    where state is not null
    order by case state
               when 'awaiting_payment' then 1
               when 'paid'             then 2
               when 'link_expired'     then 3
             end,
             coalesce(eff_paid_at, eff_expires_at) desc nulls last
    limit 1
  ),
  projected as (
    select
      w.*,
      case when w.state = 'paid'
           then proofs._project_order_tracking(w.stock_order_number, p_proof_id, w.own_status)
      end as proj,
      case when w.state = 'paid'
           then proofs._reorder_quiet_period_passed(w.stock_order_number)
           else false end as quiet_passed
    from winner w
  )
  select coalesce(
    (
      select jsonb_strip_nulls(jsonb_build_object(
        'state', p.state,
        'expires_at', case when p.state = 'awaiting_payment' then p.eff_expires_at end,
        'resend_requested_at', case when p.state = 'awaiting_payment' then p.eff_resend_at end,
        -- ⚠ Two keys only, hand-picked. Never `|| p.proj`.
        'stage',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then p.proj ->> 'stage' end,
        'delivery_tracked',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then (p.proj ->> 'delivery_tracked')::boolean end,
        'reorder_available',
          (select reorder_enabled from proofs.settings where id = 1)
            and p.state = 'paid'
            and p.quiet_passed
            and pr.status = 'approved',
        'reorder_requested_at', pr.reorder_requested_at,
        -- 000374. Null until a reorder project exists AND is safe to name —
        -- see the header. jsonb_strip_nulls drops the key entirely until then,
        -- so an older bundle and a newer one both read "no forward link".
        'reorder_proof_id', pr.reorder_proof_id
      ))
      from projected p
      cross join lateral (
        select
          pp.status,
          pp.reorder_requested_at,
          (
            select child.id
            from proofs.proofs child
            join proofs.proof_versions cpv
              on cpv.proof_id = child.id and cpv.is_current
            where child.reorder_of_proof_id = p_proof_id
              and child.status <> 'abandoned'
              and (child.status = 'approved' or cpv.last_reply_sent_at is not null)
            -- Newest first: a customer who has reordered twice wants the one
            -- they just asked for, not their first repeat from years ago.
            order by child.created_at desc
            limit 1
          ) as reorder_proof_id
        from proofs.proofs pp
        where pp.id = p_proof_id
      ) pr
    ),
    jsonb_build_object('state', 'none')
  );
$function$;

-- Grants restated (CREATE OR REPLACE preserves them; the 000148 -> 000151 and
-- 000168 -> 000174 sagas are both "the grant was silently lost"). This one is
-- anon-callable by design — it is the customer proof page's own read.
revoke execute on function proofs.public_get_proof_order_state(uuid) from public;
grant  execute on function proofs.public_get_proof_order_state(uuid) to anon, authenticated;
