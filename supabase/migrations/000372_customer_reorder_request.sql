-- 000372 — let a customer ask for more of the cards they already bought.
--
-- Spec: docs/customer-reorder-spec.md. This is steps 1-2 of its build order —
-- the settings, the eligibility maths and the read path. Deliberately INERT on
-- apply: it adds keys to a payload nothing reads yet and columns nothing writes
-- yet, and the master switch ships OFF, so the customer page is unchanged until
-- both the frontend lands and an admin turns it on.
--
-- ── Why the page, and why a request rather than a purchase ──────────────────
--
-- /p/:id is the URL customers actually keep: it's in every proof email, nothing
-- expires it, and since 000371 it answers "where has my order got to?" too. The
-- one thing it can't do is the thing a returning customer most often wants.
--
-- But reordering is a REQUEST here, never a transaction. /p/:id is deliberately
-- broad — team sharing hands `?for=<name>` links to colleagues and
-- docs/team-sharing-feature.md calls them "a convenience, not security" — so a
-- self-serve reorder would let anyone ever sent the artwork spend the company's
-- money. That is the same refusal 000367 made about the pay token, applied to
-- the more consequential action. Everything below is a FACT or a REQUEST; no
-- capability reaches the page.
--
-- ── The quiet window, and the DPD asymmetry (again) ─────────────────────────
--
-- A customer wants time to compare the delivered cards against the proof before
-- being asked to buy more, so the panel waits after delivery. But counting from
-- `delivered` alone would mean it NEVER APPEARS FOR ANY UK CUSTOMER: live at
-- authoring, FedEx had stamped 22 of its 25 paid-and-dispatched parcels and DPD
-- 0 of 63, ever. Same shape as the problem 000370 solved for the progress bar,
-- one layer up, and the same answer: count from delivery where we have it and
-- from DISPATCH where we don't, with a longer offset to cover transit. Every
-- dispatched order carries at least one usable clock, so nothing falls through;
-- an order that hasn't shipped has no clock and is correctly ineligible.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration / the dashboard SQL editor. Never
-- `supabase db push`.

-- ── 1. Settings ─────────────────────────────────────────────────────────────
-- Master switch OFF by default, per the house pattern (ordering_enabled,
-- customer_tracking_enabled, auto_nudges_enabled). The windows are admin-
-- editable because the right number is a matter of observed behaviour, not
-- something anyone can pick correctly up front.

alter table proofs.settings
  add column if not exists reorder_enabled boolean not null default false,
  add column if not exists reorder_quiet_days_after_delivery int not null default 14,
  add column if not exists reorder_quiet_days_after_dispatch int not null default 17;

comment on column proofs.settings.reorder_enabled is
  'Master switch for the customer-initiated reorder panel on /p/:id. Off by '
  'default. When off, public_get_proof_order_state always reports '
  'reorder_available false, so the panel cannot appear however the frontend '
  'is deployed.';
comment on column proofs.settings.reorder_quiet_days_after_delivery is
  'Days after a confirmed delivery before the reorder panel appears, so the '
  'customer can compare the cards against the proof first.';
comment on column proofs.settings.reorder_quiet_days_after_dispatch is
  'The same window measured from DISPATCH, for carriers that never report '
  'delivery (DPD has stamped 0 of 122 shipped parcels, ever — see 000370). '
  'Should exceed the delivery figure by roughly a transit time, or UK '
  'customers get asked sooner than everyone else.';

-- ── 2. Proof columns ────────────────────────────────────────────────────────
-- reorder_requested_at doubles as the rate-limit claim (see §4) and as the
-- acknowledgement echoed back to the page, so a reload shows "we've got it"
-- rather than re-arming the button and a second colleague can see it has
-- already been asked. Same idea as 000369's pay_link_resend_requested_at.

alter table proofs.proofs
  add column if not exists reorder_requested_at timestamptz,
  add column if not exists reorder_request_note text,
  add column if not exists reorder_request_quantity int,
  -- Set only on a proof CREATED from a customer reorder request. Distinct from
  -- the version-level cloned_from_version_id that any designer Duplicate
  -- writes: this one means "a customer asked for this", which is what the
  -- dashboard marker and the source page's forward link both key off.
  add column if not exists reorder_of_proof_id uuid
    references proofs.proofs(id) on delete set null;

create index if not exists proofs_reorder_of_proof_id_idx
  on proofs.proofs (reorder_of_proof_id)
  where reorder_of_proof_id is not null;

comment on column proofs.proofs.reorder_requested_at is
  'When a customer last asked, from /p/:id, for more of these cards. Doubles '
  'as the rate-limit claim — see proofs.claim_reorder_request().';
comment on column proofs.proofs.reorder_of_proof_id is
  'The project this one was raised from, when it was created by a customer '
  'reorder request. NOT set by a designer Duplicate — that is deliberate: this '
  'column means "a customer asked for this", which is what the dashboard '
  'marker and the source page''s forward link read.';

-- ── 3. Is this parcel far enough past the customer? ─────────────────────────
-- Reads the OUTBOUND leg only, exactly as 000269/000370 established: the
-- inbound supplier stamps (shipped_from_supplier_at / arrived_at) mean nothing
-- to the customer, and "arrived" there means arrived at US.
--
-- ⚠ In-house falls back to completed_at, not customer_shipped_at. 116 in-house
-- orders are completed but only 52 carry a shipped stamp (the shipping module
-- postdates most of them), so keying on the newer column would make most
-- historic orders permanently ineligible. Same reasoning that kept 000370's
-- "on its way" trigger where it was.

create or replace function proofs._reorder_quiet_period_passed(p_stock_order_number text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_after_delivery int;
  v_after_dispatch int;
  v_delivered_at   timestamptz;
  v_dispatched_at  timestamptz;
  ih record;
  os record;
begin
  if p_stock_order_number is null then
    return false;
  end if;

  select reorder_quiet_days_after_delivery, reorder_quiet_days_after_dispatch
    into v_after_delivery, v_after_dispatch
    from proofs.settings where id = 1;
  v_after_delivery := coalesce(v_after_delivery, 14);
  v_after_dispatch := coalesce(v_after_dispatch, 17);

  select status, completed_at, customer_delivered_at into ih
    from public.orders where order_ref = p_stock_order_number limit 1;
  if found then
    if ih.status = 'cancelled' then
      return false;
    end if;
    v_delivered_at  := ih.customer_delivered_at;
    v_dispatched_at := ih.completed_at;
  else
    select status, cancelled_at, shipped_to_customer_at, customer_delivered_at into os
      from public.outsourced_orders where customer_order_ref = p_stock_order_number limit 1;
    if not found then
      return false;
    end if;
    if os.status = 'cancelled' or os.cancelled_at is not null then
      return false;
    end if;
    v_delivered_at  := os.customer_delivered_at;
    v_dispatched_at := os.shipped_to_customer_at;
  end if;

  -- Delivery wins when we have it: it is the real event, and the dispatch
  -- window only exists to stand in for carriers that never report one.
  if v_delivered_at is not null then
    return v_delivered_at + make_interval(days => v_after_delivery) <= now();
  end if;
  if v_dispatched_at is not null then
    return v_dispatched_at + make_interval(days => v_after_dispatch) <= now();
  end if;
  return false;
end;
$function$;

revoke all on function proofs._reorder_quiet_period_passed(text) from public, anon, authenticated;

comment on function proofs._reorder_quiet_period_passed(text) is
  'Has this order been with the customer long enough to ask if they want more? '
  'Counts from delivery where the carrier reports one, otherwise from dispatch '
  'with a longer window (000370: DPD never reports delivery). EXECUTE revoked '
  'per the 000356 lesson — the proofs schema has no default function ACL, so a '
  'new function is born callable by anon through PostgREST.';

-- ── 4. The rate-limit claim ─────────────────────────────────────────────────
-- Claimed in the UPDATE's own WHERE clause rather than checked first and
-- written second (the 000346/000369 pattern): Postgres serialises the row, so
-- exactly one caller wins. This is the only thing between a widely-shared /p/
-- URL and a flood of conversations in the support queue — and it also stops two
-- colleagues both clicking from raising two jobs.
--
-- Returns true only to the caller that actually claimed it.

create or replace function proofs.claim_reorder_request(
  p_proof_id uuid,
  p_cooldown_hours int,
  p_quantity int,
  p_note text
) returns boolean
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with claimed as (
    update proofs.proofs
       set reorder_requested_at  = now(),
           reorder_request_note  = nullif(btrim(coalesce(p_note, '')), ''),
           reorder_request_quantity = p_quantity
     where id = p_proof_id
       and (reorder_requested_at is null
            or reorder_requested_at < now() - make_interval(hours => greatest(p_cooldown_hours, 1)))
    returning id
  )
  select exists (select 1 from claimed);
$function$;

revoke all on function proofs.claim_reorder_request(uuid, int, int, text) from public, anon, authenticated;
grant execute on function proofs.claim_reorder_request(uuid, int, int, text) to service_role;

comment on function proofs.claim_reorder_request(uuid, int, int, text) is
  'Service-role only. Claims the reorder-request cooldown for one proof in the '
  'UPDATE''s own WHERE clause so concurrent callers cannot both win. Returns '
  'true to the caller that claimed it. ⚠ Never grant to anon: it writes.';

-- ── 5. The read path ────────────────────────────────────────────────────────
-- public_get_proof_order_state gains two keys. Rebuilt from the LIVE
-- pg_get_functiondef (which carries 000369's resend stamp and 000371's stage),
-- never from an older migration file — the house rule after 000347/000363, and
-- this function has now been re-emitted three times.
--
-- ⚠ Still two named keys off _project_order_tracking, never `|| proj`: that
-- would carry the granular tracking_number onto a broadly-shared page (000371).
--
-- reorder_available is computed entirely server-side and returned as a bare
-- boolean. No dates, no quantities, no order id — the window can change without
-- a frontend deploy, and the payload stays a fact.

create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      -- ⚠ Payment resolves from EITHER side (000367): no group state can make
      -- an already-paid order unpaid, so the member's own stamp wins.
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at,
      -- Production is per-ORDER, never per-group: a group is a payment wrapper
      -- and its members can be made by different routes on different days.
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
  -- Pick the reported row BEFORE projecting, so the projection runs once.
  -- Note this ranking is also what makes the "no live unpaid link" half of the
  -- reorder gate free: a live link outranks a past payment, so state = 'paid'
  -- already implies there is no link outstanding.
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
        -- The whole gate, resolved server-side.
        'reorder_available',
          (select reorder_enabled from proofs.settings where id = 1)
            and p.state = 'paid'
            and p.quiet_passed
            and pr.status = 'approved',
        'reorder_requested_at', pr.reorder_requested_at
      ))
      from projected p
      cross join lateral (
        select status, reorder_requested_at from proofs.proofs where id = p_proof_id
      ) pr
    ),
    jsonb_build_object('state', 'none')
  );
$function$;

comment on function proofs.public_get_proof_order_state(uuid) is
  'Customer proof page: is there a payment link waiting, where has the order '
  'got to, and may they ask for more? Returns FACTS ONLY — state '
  '(awaiting_payment | link_expired | paid | none), a live link''s expiry, the '
  'customer''s own resend stamp, the production stage + whether delivery is '
  'trackable (000371), and whether a reorder can be requested (000372). ⚠ Never '
  'add the order id, group id, token, amounts, address, or the granular '
  'tracking_number: /p/:id is shared broadly (team sharing) while the pay link '
  'is deliberately narrow, and a pay-token holder can pay, redirect the parcel '
  'and rewrite the order spec without paying. Take named keys off '
  '_project_order_tracking, never the whole object. See 000367/000371/000372.';
