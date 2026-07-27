-- Artwork check — the run ledger (docs/artwork-check-spec.md).
--
-- WHY THIS EXISTS. The check has stored only its LATEST report per target
-- (orders.artwork_check / proof_versions.artwork_check, 000336 / 000343), which
-- is exactly right for the reviewer's card but answers none of the operational
-- questions: how often is the check actually used, by whom, and how often does
-- it find something? A re-run overwrites its predecessor, so runs 1..N-1 are
-- invisible; and the function verifies the caller's JWT but DISCARDS the user
-- id, so no run has ever recorded who asked for it.
--
-- Same shape as proof_nudges (000214): one append-only ledger row per run, so
-- the counting has a single source of truth rather than being re-derived from
-- whatever survived on the target row.
--
-- `source` is the load-bearing column, and the reason "by whom" is not simply
-- a user id. Runs arrive three ways and only ONE of them is a person choosing
-- to use the feature:
--   designer         — a human clicked Run/Re-check (order review page button,
--                      or the pre-send proof check on a proof page)
--   auto_page        — the order review page auto-ran it on open; the caller is
--                      a designer's JWT but nobody asked for it, so attributing
--                      this to them would inflate any "who uses it" reading
--   auto_folder_link — the 000337 trigger fired on a Dropbox folder link
--                      (service-role JWT; no human involved at all)
--   service          — scripts / backfills running as service_role
--   unknown          — backfilled history (below), where the source is genuinely
--                      unrecoverable. Never written by the function.
-- ran_by is stamped whenever the caller was a session JWT, INCLUDING auto_page,
-- so "opened the review page" stays separable from "asked for a check" rather
-- than being lost. Analytics keys "used by" off source, not off ran_by alone.
--
-- Errored runs are ledgered like any other: they are real usage and real spend,
-- and hiding them would flatter the success rate.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

create table if not exists proofs.artwork_check_runs (
  id uuid primary key default gen_random_uuid(),

  -- Which of the two gates ran. 'order' = the pre-print check against the
  -- Dropbox print files; 'proof' = the pre-send check against a version's own
  -- proof images. Exactly one target id is set, enforced below.
  check_kind text not null check (check_kind in ('order', 'proof')),
  order_id uuid references proofs.orders(id) on delete cascade,
  proof_version_id uuid references proofs.proof_versions(id) on delete cascade,
  -- Denormalised for grouping without a second join; SET NULL rather than
  -- CASCADE so a deleted project doesn't silently shrink historical counts.
  proof_id uuid references proofs.proofs(id) on delete set null,

  verdict text not null check (verdict in ('clear', 'flagged', 'defect', 'error')),
  source text not null check (source in ('designer', 'auto_page', 'auto_folder_link', 'service', 'unknown')),
  ran_by uuid references auth.users(id) on delete set null,

  -- Did this run replace an existing report on the target? The thing the
  -- overwrite-in-place columns can never tell us.
  is_rerun boolean not null default false,

  -- Pre-counted so "issue found" rates never parse report jsonb. Semantics are
  -- countFlags / countDefects / countCheckedFields in _shared/artworkCheck/
  -- report.ts: flags = 'flag' findings + unresolved corrections; defects = the
  -- defect-graded subset of both. Zero on errored runs.
  flag_count int not null default 0 check (flag_count >= 0),
  defect_count int not null default 0 check (defect_count >= 0),
  checked_fields int not null default 0 check (checked_fields >= 0),

  model text,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  duration_ms int,
  -- Populated on verdict 'error' only — why the run couldn't complete.
  error text,

  ran_at timestamptz not null default now(),

  constraint artwork_check_runs_one_target check (
    (check_kind = 'order' and order_id is not null and proof_version_id is null)
    or (check_kind = 'proof' and proof_version_id is not null and order_id is null)
  )
);

comment on table proofs.artwork_check_runs is
  'Append-only ledger of artwork sanity-check runs (docs/artwork-check-spec.md) — one row per run, including errors. Backs Admin → Analytics usage reporting; the latest report itself still lives on orders/proof_versions.artwork_check.';
comment on column proofs.artwork_check_runs.source is
  'How the run was triggered: designer (a human clicked) | auto_page (review page auto-ran on open) | auto_folder_link (000337 Dropbox trigger) | service (scripts) | unknown (pre-ledger backfill). Only ''designer'' means somebody chose to use the feature.';
comment on column proofs.artwork_check_runs.ran_by is
  'The session user whose JWT made the call — stamped for auto_page too, so page-opens stay separable from deliberate runs rather than being discarded. NULL for service-role and backfilled rows.';
comment on column proofs.artwork_check_runs.is_rerun is
  'True when the target already held a report that this run replaced.';

create index if not exists artwork_check_runs_ran_at_idx on proofs.artwork_check_runs (ran_at desc);
create index if not exists artwork_check_runs_kind_ran_at_idx on proofs.artwork_check_runs (check_kind, ran_at desc);
create index if not exists artwork_check_runs_ran_by_idx on proofs.artwork_check_runs (ran_by) where ran_by is not null;
create index if not exists artwork_check_runs_order_idx on proofs.artwork_check_runs (order_id) where order_id is not null;
create index if not exists artwork_check_runs_version_idx on proofs.artwork_check_runs (proof_version_id) where proof_version_id is not null;

-- Grants. The proofs schema has NO default privileges, so a new table is born
-- with none at all — service_role included. Writes are the edge function's
-- alone (service_role); authenticated gets SELECT because the analytics
-- functions are SECURITY INVOKER and read this table as the caller. No anon:
-- nothing customer-facing touches it.
alter table proofs.artwork_check_runs enable row level security;

revoke all on proofs.artwork_check_runs from anon, public;
grant select on proofs.artwork_check_runs to authenticated;
grant all on proofs.artwork_check_runs to service_role;

drop policy if exists artwork_check_runs_read on proofs.artwork_check_runs;
create policy artwork_check_runs_read on proofs.artwork_check_runs
  for select to authenticated using (true);

-- ── Backfill: the runs that happened before this ledger existed ─────────────
-- One row per target that carries a report, so the trend chart doesn't start
-- empty on the day this ships. Necessarily lossy and honest about it:
-- source 'unknown', ran_by NULL, is_rerun false — a target re-checked five
-- times contributes exactly one row, because the earlier four were overwritten
-- and are simply gone. Guarded on the ledger being empty so a re-run of this
-- migration can't double-count.
insert into proofs.artwork_check_runs (
  check_kind, order_id, proof_version_id, proof_id, verdict, source, ran_by,
  is_rerun, flag_count, defect_count, checked_fields, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  error, ran_at
)
select
  src.check_kind, src.order_id, src.proof_version_id, src.proof_id,
  src.verdict, 'unknown', null,
  false, cnt.flags, cnt.defects, cnt.checked_fields,
  src.report->>'model',
  (src.report->'usage'->>'input_tokens')::int,
  (src.report->'usage'->>'output_tokens')::int,
  (src.report->'usage'->>'cache_read_tokens')::int,
  (src.report->'usage'->>'cache_write_tokens')::int,
  src.report->>'error',
  src.ran_at
from (
  select 'order'::text as check_kind, o.id as order_id, null::uuid as proof_version_id,
         o.proof_id, o.artwork_check_verdict as verdict, o.artwork_check as report,
         o.artwork_checked_at as ran_at
  from proofs.orders o
  where o.artwork_checked_at is not null and o.artwork_check_verdict is not null
  union all
  select 'proof', null, pv.id, pv.proof_id, pv.artwork_check_verdict, pv.artwork_check,
         pv.artwork_checked_at
  from proofs.proof_versions pv
  where pv.artwork_checked_at is not null and pv.artwork_check_verdict is not null
) src
cross join lateral (
  select
    coalesce((
      select count(*) from jsonb_array_elements(coalesce(src.report->'cards', '[]'::jsonb)) c,
           jsonb_array_elements(coalesce(c->'findings', '[]'::jsonb)) f
      where f->>'status' = 'flag'
    ), 0)
    + coalesce((
      select count(*) from jsonb_array_elements(coalesce(src.report->'corrections', '[]'::jsonb)) k
      where coalesce((k->>'resolved')::boolean, false) = false
    ), 0) as flags,
    coalesce((
      select count(*) from jsonb_array_elements(coalesce(src.report->'cards', '[]'::jsonb)) c,
           jsonb_array_elements(coalesce(c->'findings', '[]'::jsonb)) f
      where f->>'status' = 'flag' and f->>'severity' = 'defect'
    ), 0)
    + coalesce((
      select count(*) from jsonb_array_elements(coalesce(src.report->'corrections', '[]'::jsonb)) k
      where coalesce((k->>'resolved')::boolean, false) = false and k->>'severity' = 'defect'
    ), 0) as defects,
    coalesce((
      select count(*) from jsonb_array_elements(coalesce(src.report->'cards', '[]'::jsonb)) c,
           jsonb_array_elements(coalesce(c->'findings', '[]'::jsonb)) f
    ), 0) as checked_fields
) cnt
where not exists (select 1 from proofs.artwork_check_runs);

-- ── Make the auto-run trigger identify itself ──────────────────────────────
-- The 000337 trigger authenticates with the service-role vault key, which is
-- indistinguishable at the function from a script or a backfill. Without a
-- marker in the body, every Dropbox-link auto-run would ledger as generic
-- 'service' and the "how much of this is automatic" split would be guesswork.
-- Body gains one field; everything else is 000337 verbatim, including the
-- exception guard that keeps an advisory check from ever failing an order
-- write. (An older deployed function simply ignores the extra field, so this
-- is safe to apply before or after the function deploy.)
create or replace function proofs.notify_artwork_check_on_folder_link()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_mode text;
  v_key  text;
begin
  if new.dropbox_folder_url is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.dropbox_folder_url is not distinct from new.dropbox_folder_url then
    return new;
  end if;

  select artwork_check_mode into v_mode from proofs.settings where id = 1;
  if coalesce(v_mode, 'off') = 'off' then
    return new;
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'proofs_send_nudges_key';
  if v_key is null then
    return new; -- no key → stay inert; never block the order write
  end if;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/artwork-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('order_id', new.id, 'force', true, 'trigger', 'auto_folder_link')
  );
  return new;
exception when others then
  return new;
end;
$$;

revoke execute on function proofs.notify_artwork_check_on_folder_link() from public, anon, authenticated;
grant execute on function proofs.notify_artwork_check_on_folder_link() to service_role;
