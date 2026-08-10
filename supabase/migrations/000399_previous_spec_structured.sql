-- 000399: give the re-engagement band the PARTS of what they last bought, not
-- just the sentence.
--
-- 000393 taught the register to say "500 gold metal cards (500 micron)". That
-- reads well and is the right thing to put in a sentence, but it is prose — the
-- page cannot act on it. A re-engaged customer lands on a price grid with three
-- thickness columns (the metal family; 237 live versions) and we already know
-- which column they bought last time. Structured values let the page badge that
-- exact column and quantity row, the same "your last order · March 2022"
-- treatment 000364 gives a returning customer at checkout.
--
-- Four fields, and the two ids are deliberately joined by a FROZEN label:
--
--   last_qty            the quantity, for the row
--   last_variant_id     the thickness they had, for the column
--   last_variant_label  what that thickness was CALLED at the time
--   last_material_id    so a marker is never shown on a different material
--
-- ⚠ The label is not redundant with the id, and it is not a cache. It is the
-- only field that survives the catalogue changing underneath us: a variant that
-- is retired, renamed, or that never existed in the catalogue at all still has
-- a name the customer would recognise. On live, 2,263 register rows carry a
-- parseable variant label but only 1,039 resolve to a catalogue variant — the
-- other 1,224 are real purchases of things like letterpress "900gsm" or perspex
-- "3mm thick", where the material is priced by ink count or is no longer in the
-- catalogue at all, so no thickness variant exists to point at. Storing the
-- label regardless is what lets the page still say what they had, and the FKs
-- are ON DELETE SET NULL for the same reason: retiring a variant must cost us
-- the marker, never the history.

-- ── 1. The columns ──────────────────────────────────────────────────────────
--
-- No grants stated: these are columns on an existing table and inherit its
-- grant matrix. (The proofs schema has no default privileges, so a new TABLE or
-- FUNCTION would need them — this migration creates neither.)

alter table proofs.reorder_prospects
  add column last_qty integer,
  add column last_variant_id uuid references proofs.material_variants(id) on delete set null,
  add column last_variant_label text,
  add column last_material_id uuid references proofs.materials(id) on delete set null;

comment on column proofs.reorder_prospects.last_qty is
  'Quantity of the customer''s last single-product order (000399). The machine-'
  'readable twin of the figure inside last_spec, written in lockstep with it, so '
  'the re-engagement price grid can mark the row they bought. Reaches the '
  'customer via proofs.reengagement_context, so display-safe only.';

comment on column proofs.reorder_prospects.last_variant_id is
  'The catalogue variant (thickness) of the customer''s last order (000399), or '
  'NULL when the label names something the catalogue has no variant for — '
  'letterpress "900gsm" and perspex "3mm thick" are real purchases of materials '
  'priced by ink count, or of materials since retired. ON DELETE SET NULL: '
  'retiring a variant costs the marker, never the history — last_variant_label '
  'still names what they had.';

comment on column proofs.reorder_prospects.last_variant_label is
  'FROZEN label for last_variant_id, e.g. "500 micron" (000399). Deliberately not '
  'derived from the variant at read time: it must survive the variant being '
  'renamed or retired, and it is populated even when no variant id resolves, '
  'which is the majority case on live (2,263 labels, 1,039 ids).';

comment on column proofs.reorder_prospects.last_material_id is
  'The material of the customer''s last order (000399). Used to REFUSE a marker '
  'when the proof in front of the customer is a different material — a "you had '
  'this one" badge on the wrong product is worse than no badge. ON DELETE SET '
  'NULL; last_spec still names the material in prose.';

-- ── 2. Backfill from the prose we already derived ───────────────────────────
--
-- last_spec was composed from Xero invoice line items and is the only record of
-- these purchases — the orders themselves predate the app. Parsing it back is
-- therefore the only route to structured values for the 2,575 rows that have
-- one, and the parse is exact because 000393 composed the string itself:
--
--   "500 gold metal cards (500 micron)"
--    ^qty ^material         ^variant
--
-- ⚠ The variant lookup is SCOPED TO THE RESOLVED MATERIAL, and that scoping is
-- load-bearing rather than tidy: "500 micron" exists as an active variant of
-- steel, gold AND gun metal, and 11 labels in total sit on more than one
-- material. Measured on live, 994 of the 1,039 resolvable rows carry such a
-- label — so an unscoped join would silently attribute the wrong variant to 96%
-- of them, and the page would badge a thickness the customer never bought while
-- looking entirely confident about it.
--
-- Materials and variants are both unique by name at the grain we look them up
-- (verified: zero duplicate material names, zero duplicate active-variant names
-- within a material), and the lookups are scalar subqueries with a deterministic
-- order, so neither can multiply rows or pick arbitrarily.

with parsed as (
  select
    rp.id,
    nullif(replace(substring(rp.last_spec from '^([0-9,]+) '), ',', ''), '')::int as qty,
    lower(substring(rp.last_spec from '^[0-9,]+ (.*) cards')) as material_text,
    lower(substring(rp.last_spec from '\(([^)]+)\)$')) as variant_label
  from proofs.reorder_prospects rp
  where rp.last_spec is not null
),
resolved as (
  select
    p.id,
    -- Range guard: a quantity outside this is a parse that went wrong, not a
    -- customer. (Live data sits at 25..10,000.)
    case when p.qty between 1 and 1000000 then p.qty end as qty,
    p.variant_label,
    (select m.id from proofs.materials m
      where lower(m.display_name) = p.material_text
      order by m.id limit 1) as material_id
  from parsed p
)
update proofs.reorder_prospects rp
set
  last_qty = r.qty,
  last_material_id = r.material_id,
  -- Stored even when no id resolves. The label IS the fallback.
  last_variant_label = r.variant_label,
  last_variant_id = (
    select mv.id from proofs.material_variants mv
    where mv.material_id = r.material_id
      and lower(mv.display_name) = r.variant_label
      and mv.is_active
    order by mv.sort_order, mv.id limit 1
  )
from resolved r
where rp.id = r.id;

-- ── 3. Let the display-safe snapshot carry them ─────────────────────────────
--
-- 000392's CHECK is subtractive: it asserts that removing the permitted keys
-- leaves an empty object, so a key not named here makes every outreach proof
-- carrying it fail to INSERT. Widened from three keys to seven, following the
-- drop + add NOT VALID + validate pattern 000393 established.
--
-- All four new keys are display-safe by inspection: a quantity, two catalogue
-- ids, and a catalogue label. Nothing derived from the register's scores,
-- lifetime value, cadence or outcome notes may ever be added here.

alter table proofs.proofs
  drop constraint proofs_reengagement_context_keys_chk;

alter table proofs.proofs
  add constraint proofs_reengagement_context_keys_chk
  check (
    reengagement_context is null
    or (
      jsonb_typeof(reengagement_context) = 'object'
      and (
        reengagement_context
        - 'last_order_on' - 'orders_count' - 'last_spec'
        - 'last_qty' - 'last_variant_id' - 'last_variant_label' - 'last_material_id'
      ) = '{}'::jsonb
    )
  )
  not valid;

alter table proofs.proofs
  validate constraint proofs_reengagement_context_keys_chk;

comment on column proofs.proofs.reengagement_context is
  'Display-safe snapshot for the re-engagement band on /p/:id (000392, widened '
  '000393 and 000399). Returned VERBATIM to anon via public_get_proof_order_state '
  '— never write anything here that a customer must not read (no scores, no '
  'lifetime value, no internal notes). Presence of the object is itself the '
  '"outreach proof" flag; the CHECK enforces the seven-key allow-list.';

-- ── 4. Keep future reconciles writing them ──────────────────────────────────
--
-- Re-emitted from the LIVE definition (pg_get_functiondef, 2026-08-09), which
-- was first diffed against the 000397 file and found byte-identical — 9,512
-- bytes, md5 83daaf4a7b68361bbc126c36c513fd18 — so there is no drift to
-- preserve. Everything below is that definition unchanged apart from the
-- structured spec, marked 000399.
--
-- Two changes, and the second exists because the first would otherwise be
-- unsafe:
--
--   a. _recon_payments carries the ids behind the two labels it already
--      derives. They are taken from the SAME order row the label came from,
--      via an ordered array_agg, NOT by an independent max(): 9 of the 200
--      payments on live are combined payments (000309) spanning more than one
--      material, and two independent maxes would cheerfully pair one
--      material's name with another material's id — the same silent
--      mis-attribution the scoped backfill above exists to prevent, arriving
--      by a different door.
--
--   b. Both halves read the latest payment ONCE, through a lateral, instead of
--      repeating `order by paid_at desc limit 1` per field. With five fields
--      that must describe the same purchase, separate subqueries are only
--      coincidentally consistent — two payments sharing a paid_at would let
--      the quantity come from one order and the thickness from another. The
--      lateral makes it structural, and adds payment_key as a deterministic
--      tiebreaker.
--
-- The four columns are written under the SAME guard as last_spec, so the parts
-- and the sentence can never describe different purchases. The variant pair is
-- written whenever a variant exists, including 'standard'/'default' — those are
-- suppressed from the SENTENCE only because "(standard)" adds nothing to prose,
-- not because the variant is unknown, and the page still needs to badge it.
--
-- ⚠ One extra guard the sentence does NOT have, and deliberately still does not
-- get here. On a combined payment spanning two materials the material label can
-- win from one order and the variant label from another, and live already
-- carries four of these — "100 satin plastic cards (500 micron)" where that 500
-- micron is Gold Metal's, and "700 matte black metal cards (carbon fibre)".
-- That prose is pre-existing and left exactly as it is; rewriting it is a
-- separate decision about wording. But the structured pair must not inherit it,
-- because last_material_id exists precisely to REFUSE a marker on a different
-- material, and a variant id belonging to some other material walks straight
-- past that check. So the variant pair is written only when the variant really
-- belongs to the material being stored; otherwise the material and quantity are
-- kept and the thickness is recorded as unknown, which is the honest answer and
-- degrades to "no column badged" rather than the wrong column badged.

create or replace function proofs.reconcile_reorder_register()
returns jsonb
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_refreshed integer := 0;
  v_enrolled integer := 0;
  v_rescored integer := 0;
begin
  -- One row per PAYMENT, with its value in its own currency and NULL where the
  -- money never went through Stripe. Shared by both halves below.
  create temp table _recon_payments on commit drop as
  select
    lower(c.email) as email,
    max(c.id::text)::uuid as contact_id,
    max(coalesce(nullif(co.name, ''), c.full_name)) as customer_name,
    coalesce(o.order_group_id::text, o.id::text) as payment_key,
    max(o.paid_at) as paid_at,
    mode() within group (order by o.currency) as currency,
    nullif(sum(
      coalesce(o.amount_cards, 0) + coalesce(o.amount_tooling, 0)
      + coalesce(o.amount_personalisation, 0) + coalesce(o.amount_shipping, 0)
      + coalesce(o.amount_us_tariff, 0) - coalesce(o.amount_card_discount, 0)
    ), 0) as total,
    max(o.quantity) as quantity,
    max(m.display_name) as material,
    max(nullif(mv.display_name, '')) as variant,
    -- 000399: the ids behind those two labels, each taken from the row whose
    -- label won, so an id can never belong to a different product than the
    -- name printed beside it.
    (array_agg(coalesce(o.material_id, mv.material_id)
       order by m.display_name desc nulls last))[1] as material_id,
    (array_agg(o.material_variant_id
       order by nullif(mv.display_name, '') desc nulls last))[1] as material_variant_id
  from proofs.orders o
  join proofs.proofs p on p.id = o.proof_id
  join proofs.contacts c on c.id = p.contact_id
  left join proofs.companies co on co.id = c.company_id
  left join proofs.material_variants mv on mv.id = o.material_variant_id
  left join proofs.materials m on m.id = coalesce(o.material_id, mv.material_id)
  where o.paid_at is not null
    and coalesce(o.order_kind, 'production') = 'production'
    and c.email is not null
    and c.email not ilike '%@example.%'
    and c.email not ilike '%.invalid'
    and coalesce(nullif(co.name, ''), c.full_name) not ilike 'joe bloggs%'
    and coalesce(nullif(co.name, ''), c.full_name) not ilike '%atari%'
  group by lower(c.email), coalesce(o.order_group_id::text, o.id::text);

  create temp table _recon_rolled on commit drop as
  select
    email,
    max(contact_id::text)::uuid as contact_id,
    max(customer_name) as customer_name,
    mode() within group (order by currency) as currency,
    min(paid_at)::date as first_order_on,
    max(paid_at)::date as last_order_on,
    count(*)::int as payments,
    -- NULL only when every payment's value is unknown.
    sum(total) as lifetime_raw
  from _recon_payments
  group by email;

  -- A. Customers already on the register who have bought again.
  --    Exactly ONE row per address absorbs it — where two rows share an
  --    address, the one with the most history wins.
  -- The durable link first (000398); email only for rows never linked. Still
  -- exactly one register row per customer, or one order is absorbed twice.
  with matched as (
    select r.email as rkey, rp.id, rp.last_reconciled_at, rp.orders_count, rp.created_at
    from _recon_rolled r
    join proofs.reorder_prospects rp
      on (rp.matched_contact_id is not null and rp.matched_contact_id = r.contact_id)
      or (rp.matched_contact_id is null and rp.email is not null
          and lower(rp.email) = r.email)
  ),
  primary_row as (
    select distinct on (rkey) rkey as email, id, last_reconciled_at
    from matched
    order by rkey, orders_count desc, created_at asc
  ),
  fresh as (
    select
      pr.id,
      r.contact_id,
      r.first_order_on,
      r.last_order_on,
      r.lifetime_raw,
      r.currency,
      (select count(*) from _recon_payments p
        where p.email = r.email and p.paid_at > pr.last_reconciled_at) as new_payments,
      (select sum(p.total) from _recon_payments p
        where p.email = r.email and p.paid_at > pr.last_reconciled_at
          and p.currency = r.currency) as new_value,
      -- 000399: one read of the latest payment, so every field below describes
      -- the same purchase.
      lastp.quantity,
      lastp.material,
      lastp.variant,
      lastp.material_id,
      lastp.material_variant_id,
      lastp.variant_matches_material
    from _recon_rolled r
    join primary_row pr on pr.email = r.email
    left join lateral (
      select p.quantity, p.material, p.variant, p.material_id, p.material_variant_id,
        -- 000399: does the thickness actually belong to the material we are
        -- about to store? False on a combined payment whose two labels came
        -- from different orders.
        exists (
          select 1 from proofs.material_variants mv2
          where mv2.id = p.material_variant_id
            and mv2.material_id = p.material_id
        ) as variant_matches_material
      from _recon_payments p
      where p.email = r.email
      order by p.paid_at desc, p.payment_key desc
      limit 1
    ) lastp on true
  )
  update proofs.reorder_prospects rp
  set
    first_order_on = least(rp.first_order_on, f.first_order_on),
    last_order_on = greatest(rp.last_order_on, f.last_order_on),
    orders_count = rp.orders_count + f.new_payments,
    matched_contact_id = coalesce(rp.matched_contact_id, f.contact_id),
    -- Kept in the ROW's currency, never converted here (defect 2).
    lifetime_value = case
      when rp.lifetime_value is null and f.new_value is null then null
      else coalesce(rp.lifetime_value, 0) + coalesce(f.new_value, 0) end,
    avg_order_value = case
      when rp.lifetime_value is null and f.new_value is null then null
      else round((coalesce(rp.lifetime_value, 0) + coalesce(f.new_value, 0))
                 / nullif(rp.orders_count + f.new_payments, 0), 2) end,
    -- The rhythm, refreshed: this is the whole point of the job (defect 4).
    cadence_days = case
      when rp.orders_count + f.new_payments >= 2
        -- nullif: two payments on one day is a single buying event, not a
        -- rhythm of zero days. Unknown is the honest answer.
        then nullif(((greatest(rp.last_order_on, f.last_order_on)
               - least(rp.first_order_on, f.first_order_on))
              / (rp.orders_count + f.new_payments - 1))::int, 0)
      else rp.cadence_days end,
    last_spec = case
      when f.quantity >= 25 and f.material is not null
        then to_char(f.quantity, 'FM999,999') || ' ' || lower(f.material) || ' cards'
             || case when f.variant is not null and lower(f.variant) not in ('standard', 'default')
                  then ' (' || lower(f.variant) || ')' else '' end
      else rp.last_spec
    end,
    -- 000399: the same purchase, in parts. Same guard as last_spec above, so
    -- the sentence and its parts can never disagree.
    last_qty = case
      when f.quantity >= 25 and f.material is not null then f.quantity
      else rp.last_qty end,
    last_material_id = case
      when f.quantity >= 25 and f.material is not null then f.material_id
      else rp.last_material_id end,
    -- The inner case is the coherence gate: a new purchase replaces the whole
    -- structured set, so where the thickness cannot be trusted to belong to the
    -- material it is cleared rather than left pointing at the OLD purchase's
    -- thickness beside the NEW purchase's material.
    last_variant_id = case
      when f.quantity >= 25 and f.material is not null
        then case when f.variant_matches_material then f.material_variant_id end
      else rp.last_variant_id end,
    last_variant_label = case
      when f.quantity >= 25 and f.material is not null
        then case when f.variant_matches_material then lower(f.variant) end
      else rp.last_variant_label end,
    suppressed_until = greatest(coalesce(rp.suppressed_until, date '1970-01-01'),
                                f.last_order_on + 180),
    -- Only states where nobody is mid-anything are reset. 'converted' in
    -- particular must survive — the payment that reaches this job is usually
    -- the very one that earned it (defect 3).
    state = case when rp.state in ('pending', 'queued', 'closed_no_response')
                 then 'pending' else rp.state end,
    last_reconciled_at = now(),
    updated_at = now()
  from fresh f
  where rp.id = f.id and f.new_payments > 0;
  get diagnostics v_refreshed = row_count;

  -- B. Customers who have only ever bought through the app.
  insert into proofs.reorder_prospects (
    customer_name, email, currency, first_order_on, last_order_on, orders_count,
    lifetime_value, avg_order_value, cadence_days, last_spec,
    last_qty, last_material_id, last_variant_id, last_variant_label,
    score, score_reasons,
    state, suppressed_until, matched_contact_id, outcome_note, last_reconciled_at
  )
  select
    r.customer_name, r.email, r.currency, r.first_order_on, r.last_order_on, r.payments,
    r.lifetime_raw,
    case when r.lifetime_raw is not null then round(r.lifetime_raw / r.payments, 2) end,
    case when r.payments >= 2
      then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end,
    case when lastp.quantity >= 25 and lastp.material is not null
      then to_char(lastp.quantity, 'FM999,999') || ' ' || lower(lastp.material) || ' cards'
           || case when lastp.variant is not null and lower(lastp.variant) not in ('standard', 'default')
                then ' (' || lower(lastp.variant) || ')' else '' end end,
    -- 000399: the same purchase, in parts.
    case when lastp.quantity >= 25 and lastp.material is not null then lastp.quantity end,
    case when lastp.quantity >= 25 and lastp.material is not null then lastp.material_id end,
    case when lastp.quantity >= 25 and lastp.material is not null
           and lastp.variant_matches_material then lastp.material_variant_id end,
    case when lastp.quantity >= 25 and lastp.material is not null
           and lastp.variant_matches_material then lower(lastp.variant) end,
    (proofs._reorder_score(r.payments, r.last_order_on,
       r.lifetime_raw * case r.currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end,
       case when r.payments >= 2
         then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end) ->> 'score')::int,
    coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(r.payments, r.last_order_on,
        r.lifetime_raw * case r.currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end,
        case when r.payments >= 2
          then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end) -> 'reasons')), '{}'),
    'pending',
    r.last_order_on + 180,
    r.contact_id,
    'Enrolled from an order placed through the app',
    now()
  from _recon_rolled r
  left join lateral (
    select p.quantity, p.material, p.variant, p.material_id, p.material_variant_id,
      exists (
        select 1 from proofs.material_variants mv2
        where mv2.id = p.material_variant_id
          and mv2.material_id = p.material_id
      ) as variant_matches_material
    from _recon_payments p
    where p.email = r.email
    order by p.paid_at desc, p.payment_key desc
    limit 1
  ) lastp on true
  where not exists (
    select 1 from proofs.reorder_prospects rp where lower(rp.email) = r.email
  )
  -- Second guard for the 50 rows with no email at all: a name that normalises
  -- to the same string is the same customer (defect 1).
  and not exists (
    select 1 from proofs.reorder_prospects rp2
    where lower(regexp_replace(rp2.customer_name, '[^a-zA-Z0-9]', '', 'g'))
        = lower(regexp_replace(r.customer_name, '[^a-zA-Z0-9]', '', 'g'))
  );
  get diagnostics v_enrolled = row_count;

  -- C. Re-score everything: recency is a third of the score and moves daily.
  --    ONE conversion, from the row's own currency (defect 2).
  update proofs.reorder_prospects rp
  set
    score = (proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) ->> 'score')::int,
    score_reasons = coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) -> 'reasons')), '{}'),
    updated_at = now()
  from (
    select id, lifetime_value
      * case currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end as gbp
    from proofs.reorder_prospects
  ) s
  where s.id = rp.id and rp.last_order_on is not null;
  get diagnostics v_rescored = row_count;

  return jsonb_build_object(
    'refreshed', v_refreshed, 'enrolled', v_enrolled, 'rescored', v_rescored, 'at', now()
  );
end;
$$;

revoke execute on function proofs.reconcile_reorder_register() from public, anon;
grant execute on function proofs.reconcile_reorder_register() to authenticated, service_role;
