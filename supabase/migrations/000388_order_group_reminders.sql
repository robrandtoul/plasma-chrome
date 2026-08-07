-- 000388_order_group_reminders.sql
-- Chase a COMBINED PAYMENT with one reminder, instead of chasing none of it.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- Background: since 000309, send-order-reminders has dropped every order with
-- an order_group_id before doing anything else. The reason was sound — a
-- reminder carries the order's OWN pay link, and a member's own link refuses
-- payment while its group is live (create-checkout-session returns
-- order_in_group), so chasing it would send the customer to a dead link — but
-- the consequence was that combined payments were never chased at all. Live
-- evidence: GRP-20509458EE (13 Jul 2026) was opened by the customer 11 hours
-- after it was created, never paid, and its link expired on 27 Jul having had
-- zero reminders. The exclusion was also invisible: unlike every other skip it
-- was a bare counter, not a ledger row, so nothing in the Outbox explained the
-- silence.
--
-- The fix mirrors 000317 (the bundle chase) one level up: a group is chased as
-- a single unit, on the combined /order/group/:id?token link, capped and spaced
-- per GROUP by the same admin cadence single orders use
-- (settings.order_reminders_max / order_reminder_interval_days, 000270).
--
-- Which Help Scout thread: a group has none of its own, and its members' proofs
-- often span several (5 of the 10 paid groups on live at authoring time spanned
-- 2+ conversations, though NO group has ever spanned two contacts — one payer
-- holds in practice). The sender therefore nominates the thread the combined
-- link was actually sent on, identified as the member proof carrying the most
-- recent staff reply after the group was created. That reply is also the send
-- evidence: unlike a single order, whose pay link create-order posts itself, a
-- group link is copied by hand, so `sent_at` alone only means "the link exists"
-- — it does not mean the customer was ever told. All 12 non-cancelled groups on
-- live satisfy that signal, so the guard costs nothing today and stops us
-- chasing someone about a link nobody sent them.
--
-- This migration is additive and inert until the matching send-order-reminders
-- deploy lands: the column is nullable, the template falls back to the code
-- default, and no existing row references a group. Deploy order is free.

-- ── Ledger: which group a reminder covers ───────────────────────────────────
-- Null for every per-order reminder (unchanged, and that is every existing
-- row). Set only on a group-level reminder; the group cap counts by it.
--
-- order_id stays NOT NULL and carries the REPRESENTATIVE member — the order
-- whose thread the reminder went out on. That keeps every existing reader
-- working unchanged (the proof timeline, the order log, the dashboard activity
-- feed all join reminders through order_id) and keeps the FK cascade honest,
-- rather than making order_id nullable and teaching five surfaces about a row
-- that belongs to no order.
--
-- ON DELETE SET NULL so deleting a group never orphans its reminder history —
-- same call as 000317's proof_set_id. ⚠ The one edge that implies: a hard-
-- deleted group's rows would fall back to looking like per-order rows for their
-- representative member. Groups are cancelled, never deleted, in every path
-- this codebase has (order-group's dissolve sets status='cancelled'), so this
-- is theoretical — but do not add a hard-delete path without revisiting it.
alter table proofs.order_nudges
  add column if not exists order_group_id uuid
    references proofs.order_groups(id) on delete set null;

comment on column proofs.order_nudges.order_group_id is
  'The combined payment (order_groups) a group-level reminder covers. Null for per-order reminders. The group reminder cap counts sending/sent rows by this column; order_id carries the representative member whose Help Scout thread it was sent on.';

-- Read index for the sender's per-group cap lookup and the Orders page roll-up.
create index if not exists order_nudges_group_idx
  on proofs.order_nudges (order_group_id, created_at desc)
  where order_group_id is not null;

-- ── The two claim gates, made disjoint ──────────────────────────────────────
-- One REAL send of each reminder stage per group, the group-level twin of the
-- existing per-order gate. Claim-first (architecture rule #2) writes the row in
-- state 'sending' under this index before the Help Scout POST; dry_run and
-- skipped rows stay outside the predicate so a dry week never blocks the first
-- live send.
create unique index if not exists order_nudges_group_claim
  on proofs.order_nudges (order_group_id, reminder_no)
  where source = 'auto' and state in ('sending', 'sent') and order_group_id is not null;

-- ⚠ Load-bearing: the per-order gate must now EXCLUDE group rows, because a
-- group reminder also occupies its representative member's (order_id,
-- reminder_no). Without this, splitting a group up (order-group 'release' /
-- 'dissolve', which returns a member to a standalone live link) would leave its
-- old group rows squatting on the member's stages: the standalone reminder's
-- INSERT would raise 23505, which insertLedger reads as "another run already
-- handled it" and skips — so that reminder would never send, and nothing would
-- say why. The two predicates are exact complements on order_group_id, so every
-- row is governed by exactly one of them.
--
-- Recreated rather than left alone: a released member starts its own chase from
-- reminder 1, because it now has a NEW pay link the customer has never been
-- sent. Group reminders and per-order reminders are separate ledgers, and the
-- sender + the Orders page both read per-order state with
-- `order_group_id is null` to match.
drop index if exists proofs.order_nudges_auto_claim;
create unique index order_nudges_auto_claim
  on proofs.order_nudges (order_id, reminder_no)
  where source = 'auto' and state in ('sending', 'sent') and order_group_id is null;

-- ── The combined-payment reminder body ──────────────────────────────────────
-- Same house pattern as 000238/000317: ON CONFLICT DO NOTHING so an admin-edited
-- body is never clobbered; the default mirrors ORDER_REMINDER_DEFAULT_BODIES in
-- supabase/functions/_shared/replyTemplates.ts and DEFAULT_BODIES in
-- src/lib/replyTemplates.ts. No sign-off — Help Scout appends the signature.
--
-- Deliberately the SAME four variables as order_reminder_1 ({first_name},
-- {company}, {order_url}, {order_expiry}) — {order_url} being the combined
-- /order/group/ link and {order_expiry} the group's own expiry. No card-count
-- variable: it would have to join the shared 'order_reminder' variable scope
-- (AdminTemplatesSection.templateScope matches on the order_reminder prefix, so
-- this id resolves there for free), where it would render empty on
-- order_reminder_1 and read as a broken variable to whoever edits it next.
--
-- The id keeps the order_reminder prefix on purpose: that is what routes it
-- into the "Order messages" group with the right variable help panel, with no
-- admin-page change at all.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_reminder_group',
    'Order reminder — combined payment',
    'The repeating automated reminder for a combined payment whose link was sent but not paid. Covers every card in the group; {order_url} is the one combined pay link.',
    E'Hi {first_name},\n\nJust a reminder that your card orders{? company} for {company}{/?} are approved and ready whenever you''re set. They''re on a single payment link, so you can settle them all together here:\n\n{order_url}{? order_expiry}\n\nThis payment link expires on {order_expiry}.{/?}'
  )
on conflict (id) do nothing;
