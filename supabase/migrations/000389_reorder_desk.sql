-- 000389: The Reorder desk — re-engaging past customers from the back book.
--
-- A scored register of past customers (seeded from three years of Xero invoice
-- history, kept current by ordinary orders from here on) served to designers as
-- a small daily worklist on the dashboard: build their proof from archived
-- artwork, send ONE personal outreach note, at most ONE personal follow-up if
-- they showed interest, then either a normal order journey or silence.
--
-- Design decisions this schema carries (agreed with Rob, 9 Aug 2026):
--   * Outreach projects are marked at birth (proofs.reengagement_prospect_id)
--     so analytics can keep them OUT of organic conversion stats (000390) and
--     the desk can track outcomes without a parallel campaign tool.
--   * Standard automated chasing is suppressed for this population — the desk
--     stamps proofs.auto_nudge_disabled_at at creation (the existing per-proof
--     opt-out the nudge pipeline already honours) and snoozes the chase rules.
--     The chase templates presume the customer ASKED for the work; these
--     customers did not. Follow-ups are desk cards a human sends.
--   * Everything ships dormant: settings.reorder_desk_enabled default false.
--
-- ⚠ proofs schema has NO default privileges: every object states its grants.
-- Apply BEFORE 000390 (which references the new proofs column).

-- 1. The register ------------------------------------------------------------

create table proofs.reorder_prospects (
  id uuid primary key default gen_random_uuid(),
  -- Identity as Xero knows it; email resolved for the contactable cohort.
  xero_contact_id text unique,
  customer_name text not null,
  email text,
  -- History summary (from PAID sales invoices).
  currency text,
  first_order_on date,
  last_order_on date,
  orders_count integer not null default 0,
  lifetime_value numeric(12,2),
  avg_order_value numeric(12,2),
  -- Average days between their orders; null for one-time buyers.
  cadence_days integer,
  -- Transparent score + the human-readable reasons the card shows.
  score integer not null default 0,
  score_reasons text[] not null default '{}',
  -- Lifecycle. 'pending' = in the register, not yet served; 'queued' = served
  -- on the desk today; 'in_build' = designer creating the project; 'contacted'
  -- = outreach sent; 'replied' / 'converted' / 'declined' are outcomes;
  -- 'closed_no_response' = the quiet close after the follow-up window;
  -- 'suppressed' = do not contact (bounce, opt-out, bad data).
  state text not null default 'pending' check (state in (
    'pending','queued','in_build','contacted','replied','converted',
    'declined','closed_no_response','suppressed')),
  queued_on date,
  contacted_at timestamptz,
  follow_up_due_on date,
  followed_up_at timestamptz,
  -- The outreach project, once a designer creates it.
  proof_id uuid references proofs.proofs(id) on delete set null,
  -- An existing in-app contact match (post-June customers), if any.
  matched_contact_id uuid references proofs.contacts(id) on delete set null,
  outcome_note text,
  -- Re-eligibility guard: not offered again before this date.
  suppressed_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reorder_prospects_serve_idx
  on proofs.reorder_prospects (state, score desc);
create index reorder_prospects_proof_idx
  on proofs.reorder_prospects (proof_id) where proof_id is not null;

alter table proofs.reorder_prospects enable row level security;

create policy "reorder_prospects: authenticated read"
  on proofs.reorder_prospects for select to authenticated using (true);
create policy "reorder_prospects: authenticated insert"
  on proofs.reorder_prospects for insert to authenticated with check (true);
create policy "reorder_prospects: authenticated update"
  on proofs.reorder_prospects for update to authenticated using (true);
create policy "reorder_prospects: authenticated delete"
  on proofs.reorder_prospects for delete to authenticated using (true);

grant select, insert, update, delete on proofs.reorder_prospects to authenticated;
grant all on proofs.reorder_prospects to service_role;

-- 2. Mark outreach-origin projects on proofs ---------------------------------

alter table proofs.proofs
  add column reengagement_prospect_id uuid
    references proofs.reorder_prospects(id) on delete set null;

create index proofs_reengagement_idx
  on proofs.proofs (reengagement_prospect_id)
  where reengagement_prospect_id is not null;

-- 3. Desk settings (dormant by default) --------------------------------------

alter table proofs.settings
  add column reorder_desk_enabled boolean not null default false,
  add column reorder_desk_daily_limit integer not null default 5
    check (reorder_desk_daily_limit between 1 and 20),
  add column reorder_desk_followup_days integer not null default 5
    check (reorder_desk_followup_days between 1 and 30);

-- 4. The two outreach templates ----------------------------------------------
-- House seed pattern (000157/000207): admin-editable rows, code defaults
-- mirrored in src/lib/replyTemplates.ts DEFAULT_BODIES, no sign-off (the send
-- flow appends the sender's own), on conflict do nothing for safe replay.
-- ⚠ Deliberately NOT the standard chase templates: those bodies presume the
-- customer requested the work. These are written for someone WE approached.

insert into proofs.reply_templates (id, display_name, description, body) values
(
  'reorder_outreach',
  'Re-engagement — first note',
  'The one personal note the Reorder desk sends a past customer. Their proof page is already built; {url} points at it.',
  'Hi {first_name},

We made your business cards a while back, and I wondered how you''re doing for stock.

Your artwork is still on file, so a repeat run is simple — we''ve put your page together with everything ready to look over, along with current prices:

{url}

If anything needs updating first — a name, a job title, a detail — just reply and we''ll sort it before anything is printed. And if now isn''t the right time, no problem at all: say the word and we''ll leave you be.'
),
(
  'reorder_outreach_followup',
  'Re-engagement — follow-up',
  'The at-most-one follow-up, only for past customers who OPENED their page and went quiet. Sent by a person from the desk, never automatically.',
  'Hi {first_name},

Just floating this back up in case it slipped by — your cards are ready to reorder whenever suits, and there''s no obligation at all:

{url}

If now''s not the right time, that''s absolutely fine; we''ll leave it with you.'
)
on conflict (id) do nothing;

-- 5. Analytics ---------------------------------------------------------------
-- House pattern (000276/000358): one json round trip, language sql, stable,
-- SECURITY INVOKER. ⚠ The explicit revoke is load-bearing: the proofs schema
-- has no default function ACL, so a new function is born EXECUTE TO PUBLIC
-- with anon holding schema usage (the 000356 lesson).

create or replace function proofs.analytics_reengagement(p_days integer default 90)
returns json
language sql stable
set search_path = proofs, public, extensions, pg_temp
as $$
  with op as (
    select p.id, p.reengagement_prospect_id, p.status,
      exists (
        select 1 from proof_versions pv
        join proof_version_views vv on vv.proof_version_id = pv.id and vv.is_bot = false
        where pv.proof_id = p.id
      ) as opened,
      exists (
        select 1 from orders o
        where o.proof_id = p.id and (o.paid_at is not null or o.status in ('paid','fulfilled'))
      ) as paid
    from proofs p
    where p.reengagement_prospect_id is not null
  ),
  paid_val as (
    select o.currency,
      count(*) as n,
      sum(coalesce(o.amount_cards,0) + coalesce(o.amount_tooling,0)
        + coalesce(o.amount_personalisation,0) + coalesce(o.amount_shipping,0)
        + coalesce(o.amount_us_tariff,0) - coalesce(o.amount_card_discount,0)) as total
    from orders o
    join proofs p on p.id = o.proof_id
    where p.reengagement_prospect_id is not null and o.paid_at is not null
    group by o.currency
  ),
  wk as (
    select date_trunc('week', pr.contacted_at)::date as week_start,
      count(*) as contacted,
      count(*) filter (where op.opened) as opened,
      count(*) filter (where op.status = 'approved') as approved,
      count(*) filter (where op.paid) as paid
    from reorder_prospects pr
    left join op on op.reengagement_prospect_id = pr.id
    where pr.contacted_at is not null
      and pr.contacted_at >= now() - make_interval(days => p_days)
    group by 1 order by 1
  )
  select json_build_object(
    'window_days', p_days,
    'register', json_build_object(
      'total', (select count(*) from reorder_prospects),
      'pending', (select count(*) from reorder_prospects where state in ('pending','queued')),
      'in_build', (select count(*) from reorder_prospects where state = 'in_build'),
      'contacted', (select count(*) from reorder_prospects where state in ('contacted','replied')),
      'converted', (select count(*) from reorder_prospects where state = 'converted'),
      'declined', (select count(*) from reorder_prospects where state = 'declined'),
      'closed_no_response', (select count(*) from reorder_prospects where state = 'closed_no_response'),
      'suppressed', (select count(*) from reorder_prospects where state = 'suppressed')
    ),
    'outreach', json_build_object(
      'contacted_in_window', (select count(*) from reorder_prospects
        where contacted_at >= now() - make_interval(days => p_days)),
      'opened', (select count(*) from op where opened),
      'approved', (select count(*) from op where status = 'approved'),
      'paid', (select count(*) from op where paid),
      'paid_value', (select coalesce(json_agg(json_build_object(
        'currency', currency, 'orders', n, 'total', total)), '[]'::json) from paid_val)
    ),
    'weekly', (select coalesce(json_agg(row_to_json(wk)), '[]'::json) from wk)
  );
$$;

revoke execute on function proofs.analytics_reengagement(integer) from public, anon;
grant execute on function proofs.analytics_reengagement(integer) to authenticated, service_role;
