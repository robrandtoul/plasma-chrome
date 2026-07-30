-- 000371 — the proof page can say where the order actually is, not just that
-- it was paid for.
--
-- 000367 gave /p/:id a four-valued fact (awaiting_payment | link_expired |
-- paid | none) so the page could stop looking broken to someone trying to buy.
-- `paid` deliberately rendered NOTHING, on the reasoning that "the proof page
-- is not the order page — status and delivery live on the pay page, which they
-- reached to pay".
--
-- That reasoning holds for a customer who still has their pay link. It does not
-- hold for the one who doesn't: /p/:id is the URL we put in every proof email,
-- the one customers bookmark and forward to colleagues, whereas the pay link is
-- a single tokenised email they may well have deleted the moment they paid.
-- Telling that person "check the other page" assumes a link they no longer
-- have. So the same progress the pay page shows is now available here.
--
-- ── What this adds, and what it still refuses ───────────────────────────────
--
-- Added: `stage` (paid | in_production | on_its_way | delivered) and
-- `delivery_tracked`, both straight from proofs._project_order_tracking — the
-- same projection the pay page reads, so the two surfaces cannot drift into
-- telling one customer two different stories.
--
-- Still refused, exactly as 000367 set out: no order id, no group id, no token,
-- no amounts, no currency, no quantity, no spec, no contact details, no
-- delivery address. A stage is a FACT about a parcel; none of it is a
-- capability, and none of it can be turned into one.
--
-- ⚠ AND ONE NEW REFUSAL: the tracking NUMBER is never emitted here, even when
-- the admin config sets a route to 'granular' and the pay page is showing it.
-- The pay page is reached with a bearer token posted to the project contact;
-- /p/:id is handed around by team sharing, which docs/team-sharing-feature.md
-- calls "a convenience, not security". A tracking number is the one field in
-- the projection that lets a stranger act on the parcel rather than merely read
-- about it — most carriers let the holder of a tracking number reroute or
-- redirect a delivery. So this function reads the projection and takes only the
-- two narrative keys. It is deliberately NOT `|| v_proj`.
--
-- The admin master switch and per-route config come along for free: the
-- projection returns level 'off' when tracking is disabled, and this reads the
-- stage only when the level is broad or granular. Turning tracking off in
-- Admin -> Settings silences both surfaces at once, which is what an operator
-- pressing that switch expects.
--
-- Rebuilt from the LIVE pg_get_functiondef (which carries 000369's
-- resend_requested_at), NOT from the 000367 file — the house rule after
-- 000347/000363, and this function has already been re-emitted once inside two
-- days. Signature unchanged so CREATE OR REPLACE keeps the anon grant.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration / the dashboard SQL editor. Never
-- `supabase db push`.

create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      -- A grouped member pays through its GROUP's link: its own row stays
      -- 'sent' with a dormant link and a frozen expiry, and OrderPayPage
      -- refuses its own token while the group is live. So the group governs
      -- both the status and the deadline. A cancelled group releases its
      -- members back to their own links (order-lifecycle), which is why
      -- that one state falls through to the order's own columns.
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      -- ⚠ Payment resolves from EITHER side (see 000367): no group state can
      -- make an already-paid order unpaid, so the member's own stamp wins.
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      -- Same resolution rule as the status/deadline above: the resend is
      -- held against whichever row is actually payable.
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at,
      -- Production is per-ORDER, never per-group: a group is a payment
      -- wrapper, and its members can be made by different routes on
      -- different days. So these two come off the order row even when the
      -- group governs the money above.
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
        -- Money first, read from paid_at rather than the status text.
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        else null
      end as state
    from resolved r
  ),
  -- Pick the row we're reporting on BEFORE projecting its tracking, so the
  -- projection runs once rather than per historic order row.
  winner as (
    select *
    from ranked
    where state is not null
    -- 000340 allows at most one LIVE pay link per proof, but a proof can
    -- carry historic rows (a paid original beside a cancelled retry), so
    -- rank deterministically: a live link outranks a past payment, which
    -- outranks a dead link; ties break on the most recent date.
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
      end as proj
    from winner w
  )
  select coalesce(
    (
      select jsonb_strip_nulls(jsonb_build_object(
        'state', p.state,
        'expires_at', case when p.state = 'awaiting_payment' then p.eff_expires_at end,
        -- Only where a resend is offered. The customer's own click, echoed
        -- back so a reload shows the acknowledgement instead of re-arming
        -- the button. No id, no token — the 000367 rule stands.
        'resend_requested_at', case when p.state = 'awaiting_payment' then p.eff_resend_at end,
        -- ⚠ Two keys only, hand-picked. Never `|| p.proj` — that would carry
        -- the granular tracking_number onto a broadly-shared page. See header.
        'stage',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then p.proj ->> 'stage' end,
        'delivery_tracked',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then (p.proj ->> 'delivery_tracked')::boolean end
      ))
      from projected p
    ),
    jsonb_build_object('state', 'none')
  );
$function$;

comment on function proofs.public_get_proof_order_state(uuid) is
  'Customer proof page: is there a payment link waiting, and where has the '
  'order got to? Returns FACTS ONLY — state (awaiting_payment | link_expired | '
  'paid | none), a live link''s expiry, the customer''s own resend stamp, and '
  '(000371) the production stage + whether delivery is trackable. ⚠ Never add '
  'the order id, group id, token, amounts, address, or the granular '
  'tracking_number: /p/:id is shared broadly (team sharing) while the pay link '
  'is deliberately narrow, and a pay-token holder can pay, redirect the parcel '
  'and rewrite the order spec without paying. Take named keys off '
  '_project_order_tracking, never the whole object. See 000367/000371 headers '
  'and src/lib/customerProofUrl.ts:26-34.';
