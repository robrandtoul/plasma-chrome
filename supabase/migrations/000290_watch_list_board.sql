-- 000290: Watch list — staff board for tracking problem projects/orders.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- A shared, all-staff board for problem projects: cards lost in transit, awaiting
-- a reprint, complained about, running late, etc. Anyone signed in can flag a
-- project, change a card's status (open → monitoring → resolved), and add an
-- append-only thread of updates (notes + logged phone calls) so whoever picks up
-- the phone can see the latest. Deliberately collaborative — NOT admin-gated like
-- the feedback board (000271): any staffer can triage. Every card hangs off a
-- real proof; there are no free-standing cards.
--
-- Two tables:
--   1. proofs.watch_items   — one row per flagged project (the card)
--   2. proofs.watch_updates — the shared update thread (one row per note/call)
--
-- ⚠ Grants note (the proofs schema has NO default privileges — a new table is
-- born with no grants at all, service_role included): every grant below is
-- explicit. Display fields are DENORMALISED onto the row because profiles is
-- self-read-only under RLS (a join can't show "flagged by Chris" or the proof's
-- designer). The author copies are stamped server-side from the caller's own
-- profile by a BEFORE INSERT trigger so they can't be spoofed via a raw REST
-- insert; the proof-context copies (company/contact/designer/order) are derived
-- from the proof in the same trigger so every insert path produces a consistent
-- card. created_by stays an FK (ON DELETE SET NULL) for attribution + the insert
-- RLS check. Same idiom as feedback_items (000271) + the dashboard snooze columns.
--
-- Delete gate uses the existing proofs.is_admin() helper (SECURITY DEFINER,
-- search_path-pinned) — the house pattern — so a mis-flagged card can't be wiped
-- by just anyone, while status/notes stay open to all.

begin;

-- ── 1. watch_items ───────────────────────────────────────────────────────────

create table proofs.watch_items (
  id                     uuid        primary key default gen_random_uuid(),
  -- Every card is anchored to a real project. CASCADE so deleting a proof
  -- (delete_proof_cascade, 000243) takes its watch card + thread with it.
  proof_id               uuid        not null references proofs.proofs(id) on delete cascade,
  category               text        not null default 'general'
                           check (category in ('lost_in_transit', 'reprint',
                                               'quality_complaint', 'delayed',
                                               'payment_issue', 'general')),
  status                 text        not null default 'open'
                           check (status in ('open', 'monitoring', 'resolved')),
  -- The date the customer ordered — auto-filled by the trigger from the proof's
  -- most recent order (if one exists), null when the project has no order yet.
  ordered_on             date,
  -- Denormalised proof context (profiles is self-read-only; the order/contact
  -- joins are awkward from the client). Snapshotted at flag time by the trigger.
  company_name           text,
  contact_name           text,
  designer_name          text,
  -- The latest order's stock number (bridge to the Stock Control app) + the HS
  -- thread, for quick cross-reference links on the card.
  stock_order_number     text,
  helpscout_conversation_url text,
  -- Who flagged it. FK for the insert RLS check + delete-own; nullable so the row
  -- survives account removal. *_name/_initials/_colour are display copies stamped
  -- server-side from the caller's own profile (anti-spoof).
  created_by             uuid        references proofs.profiles(id) on delete set null,
  created_by_name        text,
  created_by_initials    text,
  created_by_colour      text,
  -- Who last moved the card through the pipeline, stamped by the page (the
  -- mover is always the current user, who can read their own profile name).
  status_changed_at      timestamptz,
  status_changed_by      uuid        references proofs.profiles(id) on delete set null,
  status_changed_by_name text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Default board sort is newest-first within a status section.
create index watch_items_status_idx on proofs.watch_items (status, created_at desc);
-- Look up a proof's existing card (so "Flag a project" can detect a live flag).
create index watch_items_proof_idx  on proofs.watch_items (proof_id);
-- At most one un-resolved card per proof: you can't double-flag a project that's
-- already on the board, but a resolved proof can be flagged again if it recurs.
create unique index watch_items_one_open_per_proof
  on proofs.watch_items (proof_id) where status <> 'resolved';

alter table proofs.watch_items enable row level security;

-- Everyone signed in sees the whole board.
create policy watch_items_select on proofs.watch_items
  for select to authenticated using (true);

-- Anyone signed in can flag a project, but only as themselves (created_by =
-- auth.uid() blocks spoofing another person's attribution).
create policy watch_items_insert on proofs.watch_items
  for insert to authenticated
  with check (created_by = auth.uid());

-- Collaborative: any staffer can change status / edit a card (Rob's choice — an
-- ops board everyone contributes to, not an admin triage queue).
create policy watch_items_update on proofs.watch_items
  for update to authenticated
  using (true) with check (true);

-- The flagger can remove their own card; an admin can remove anyone's. Heavier
-- than a status change, so it isn't wide-open like update.
create policy watch_items_delete on proofs.watch_items
  for delete to authenticated
  using (created_by = auth.uid() or proofs.is_admin());

revoke all on proofs.watch_items from anon, public;
grant select, insert, update, delete on proofs.watch_items to authenticated;
grant all on proofs.watch_items to service_role;

comment on table proofs.watch_items is
  'Watch list board — staff-flagged problem projects (lost in transit, reprint, '
  'complaint, delayed, payment). Anyone authenticated reads all, flags their own, '
  'and changes status; delete is flagger-or-admin. Always anchored to a proof. '
  'Proof + author context denormalised (profiles is self-read-only) and stamped '
  'by watch_items_set_context so the card is consistent across insert paths.';

-- ── 2. watch_updates (the shared thread) ─────────────────────────────────────

create table proofs.watch_updates (
  id                  uuid        primary key default gen_random_uuid(),
  watch_item_id       uuid        not null references proofs.watch_items(id) on delete cascade,
  -- A plain note or a logged phone call (renders with a little phone chip).
  kind                text        not null default 'note'
                        check (kind in ('note', 'phone_call')),
  body                text        not null,
  created_by          uuid        references proofs.profiles(id) on delete set null,
  created_by_name     text,
  created_by_initials text,
  created_by_colour   text,
  created_at          timestamptz not null default now()
);

-- Thread reads oldest-first under a card.
create index watch_updates_item_idx on proofs.watch_updates (watch_item_id, created_at);

alter table proofs.watch_updates enable row level security;

create policy watch_updates_select on proofs.watch_updates
  for select to authenticated using (true);

create policy watch_updates_insert on proofs.watch_updates
  for insert to authenticated
  with check (created_by = auth.uid());

-- Append-only by design (a logged call shouldn't be silently rewritten); no
-- UPDATE policy. Author or admin can delete a mistaken entry.
create policy watch_updates_delete on proofs.watch_updates
  for delete to authenticated
  using (created_by = auth.uid() or proofs.is_admin());

revoke all on proofs.watch_updates from anon, public;
grant select, insert, delete on proofs.watch_updates to authenticated;
grant all on proofs.watch_updates to service_role;

comment on table proofs.watch_updates is
  'Append-only update thread under a watch_items card — staff notes + logged '
  'phone calls. Author display fields stamped by watch_updates_set_author.';

-- ── 3. triggers: stamp author + proof context server-side ────────────────────
-- created_by is forced to auth.uid() by the insert RLS check; the client never
-- supplies the display copies. SECURITY DEFINER so the function can read
-- profiles regardless of its self-read-only RLS; EXECUTE revoked from callers (a
-- trigger fires regardless of EXECUTE — same hardening as 000182 / 000271).

create or replace function proofs.watch_items_set_context()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  -- Author identity from the caller's own profile.
  select p.full_name, p.designer_initials, p.designer_colour
    into new.created_by_name, new.created_by_initials, new.created_by_colour
  from proofs.profiles p
  where p.id = new.created_by;

  -- Proof context (company / contact / designer / HS thread).
  select co.name, c.full_name, pr.full_name, pf.helpscout_conversation_url
    into new.company_name, new.contact_name, new.designer_name,
         new.helpscout_conversation_url
  from proofs.proofs pf
  left join proofs.contacts  c  on c.id  = pf.contact_id
  left join proofs.companies co on co.id = c.company_id
  left join proofs.profiles  pr on pr.id = pf.created_by
  where pf.id = new.proof_id;

  -- Ordered date + stock number from the proof's most recent order, if any.
  select (coalesce(o.paid_at, o.sent_at, o.created_at))::date, o.stock_order_number
    into new.ordered_on, new.stock_order_number
  from proofs.orders o
  where o.proof_id = new.proof_id
  order by o.created_at desc
  limit 1;

  return new;
end;
$$;

revoke execute on function proofs.watch_items_set_context() from public, anon, authenticated;
grant execute on function proofs.watch_items_set_context() to service_role;

create trigger watch_items_set_context
  before insert on proofs.watch_items
  for each row execute function proofs.watch_items_set_context();

create or replace function proofs.watch_updates_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  select p.full_name, p.designer_initials, p.designer_colour
    into new.created_by_name, new.created_by_initials, new.created_by_colour
  from proofs.profiles p
  where p.id = new.created_by;
  return new;
end;
$$;

revoke execute on function proofs.watch_updates_set_author() from public, anon, authenticated;
grant execute on function proofs.watch_updates_set_author() to service_role;

create trigger watch_updates_set_author
  before insert on proofs.watch_updates
  for each row execute function proofs.watch_updates_set_author();

commit;
