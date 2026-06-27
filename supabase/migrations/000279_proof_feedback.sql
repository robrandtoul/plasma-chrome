-- 000279_proof_feedback.sql
--
-- "Decline feedback + price recovery" feature. When a customer isn't ready to
-- approve, the proof page offers face-saving reason options (price / different
-- direction / timing / going elsewhere / still thinking). We record the reason
-- (the learning loop), and for a price objection show recovery offers (a lower
-- quantity, a cheaper same-category material, an optional discount). Built from
-- the 2026-06-27 follow-up analysis: price is the #1 stated reason for a lost
-- proof and in every case the customer liked the design — see
-- memory:conversion-analytics-baseline.
--
-- This migration adds: the proof_feedback table, the discount settings (OFF by
-- default — auto-discounting touches margin, so a human sets the size), the anon
-- cheaper-alternatives RPC the proof page calls, and the loss-reasons analytics
-- function. The write path is the service-role `proof-feedback` edge function;
-- this is NOT an approval state, so the proof stays open and the customer can
-- still approve later.

-- ── proof_feedback ──────────────────────────────────────────────────────────
create table if not exists proofs.proof_feedback (
  id uuid primary key default gen_random_uuid(),
  proof_id uuid not null references proofs.proofs(id) on delete cascade,
  proof_version_id uuid references proofs.proof_versions(id) on delete set null,
  reason_code text not null check (reason_code in (
    'price_too_high', 'different_direction', 'timing', 'going_elsewhere', 'still_thinking'
  )),
  note text,
  -- Snapshot of what the page offered at decline time (lower-qty price, cheaper
  -- material, discount %), so the designer/analytics can see what was on the table.
  recovery_offer jsonb,
  actor_name text,
  currency text,
  from_ip inet,
  from_ua text,
  created_at timestamptz not null default now()
);
create index if not exists proof_feedback_proof_id_idx on proofs.proof_feedback (proof_id);
create index if not exists proof_feedback_created_at_idx on proofs.proof_feedback (created_at desc);

alter table proofs.proof_feedback enable row level security;

-- Designers read all; the write path is the service-role proof-feedback edge
-- function (RLS-bypassing), so no anon/authenticated insert. The 000176 ALTER
-- DEFAULT PRIVILEGES would have granted authenticated full CRUD, so revoke the
-- writes explicitly (the 000178 footgun) and keep authenticated to SELECT only.
revoke all on proofs.proof_feedback from anon, authenticated;
grant select on proofs.proof_feedback to authenticated;
grant select, insert, update, delete on proofs.proof_feedback to service_role;

drop policy if exists "proof_feedback: authenticated read" on proofs.proof_feedback;
create policy "proof_feedback: authenticated read"
  on proofs.proof_feedback for select to authenticated using (true);

-- ── discount recovery settings (off by default) ─────────────────────────────
alter table proofs.settings
  add column if not exists decline_recovery_discount_enabled boolean not null default false,
  add column if not exists decline_recovery_discount_percent numeric(5,2) not null default 0
    check (decline_recovery_discount_percent >= 0 and decline_recovery_discount_percent <= 100);

-- ── public_get_cheaper_alternatives (anon) ──────────────────────────────────
-- Same-category published materials cheaper than the proof's current material,
-- with their cheapest total price in the proof's currency. SECURITY DEFINER anon
-- RPC, pricing-data-only (no customer/proof/contact data) — same house pattern
-- as public_get_price_list (000184). Returns empty alternatives for a
-- per-direction proof (null material) or when nothing cheaper exists.
create or replace function proofs.public_get_cheaper_alternatives(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with pick as (
    select pv.material_id, pv.currency::text as currency, m.category
    from proof_versions pv
    join materials m on m.id = pv.material_id
    where pv.proof_id = p_proof_id and pv.is_current and m.category is not null
    limit 1
  ),
  curmin as (
    select min(pt.total_price) as min_total
    from price_tiers pt
    join material_variants mv on mv.id = pt.material_variant_id
    where mv.material_id = (select material_id from pick) and pt.currency = (select currency from pick)
  ),
  alts as (
    select m.display_name, m.code, min(pt.total_price) as from_total
    from materials m
    join material_variants mv on mv.material_id = m.id and mv.is_active
    join price_tiers pt on pt.material_variant_id = mv.id and pt.currency = (select currency from pick)
    where m.is_active and m.is_published and m.archived_at is null
      and m.category = (select category from pick)
      and m.id <> (select material_id from pick)
    group by m.display_name, m.code
    having min(pt.total_price) < (select min_total from curmin)
    order by min(pt.total_price)
    limit 3
  )
  select jsonb_build_object(
    'currency', (select currency from pick),
    'current_from_total', (select min_total from curmin),
    'alternatives', coalesce(
      (select jsonb_agg(jsonb_build_object('display_name', display_name, 'code', code, 'from_total', from_total) order by from_total) from alts),
      '[]'::jsonb
    ),
    -- Discount config travels with this RPC so the anon proof page gets it
    -- without reading the (anon-revoked) settings table. 0 when disabled.
    'discount_percent', coalesce(
      (select case when decline_recovery_discount_enabled then decline_recovery_discount_percent else 0 end from settings limit 1),
      0
    )
  );
$$;
revoke all on function proofs.public_get_cheaper_alternatives(uuid) from public;
grant execute on function proofs.public_get_cheaper_alternatives(uuid) to anon, authenticated;

-- ── analytics_loss_reasons (authenticated) ──────────────────────────────────
-- Powers the "Why we lose" panel on Admin → Analytics.
create or replace function proofs.analytics_loss_reasons()
returns table (reason_code text, n int, latest_at timestamptz)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  select reason_code, count(*)::int, max(created_at)
  from proof_feedback
  group by reason_code
  order by count(*) desc;
$$;
revoke all on function proofs.analytics_loss_reasons() from public, anon;
grant execute on function proofs.analytics_loss_reasons() to authenticated;
