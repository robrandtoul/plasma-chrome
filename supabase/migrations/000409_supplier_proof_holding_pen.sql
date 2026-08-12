-- 000409: the supplier proof holding pen — a fourth stage for a placed order.
--
-- A supplier order does not end when we email it. QX Metals (and Solopress, and
-- Swype) reply with their own internal proof for us to approve, and only once we
-- have approved it is the order genuinely away. Until now that step lived in Help
-- Scout and in somebody's head: `place-order` stamped `supplier_email_sent_at`,
-- the card dropped into "Recently ordered", and the project was closed off.
--
-- The hole that left: if the supplier never received the order email, or simply
-- forgot to reply, nothing told us. We found out a fortnight later when the cards
-- didn't ship.
--
-- ── The signal was always here ───────────────────────────────────────────────
-- `place-order` opens a NEW Help Scout conversation per supplier order (the
-- supplier is the conversation's customer) and stores its id on
-- orders.supplier_helpscout_conversation_id — populated on 46 of 46 supplier
-- orders since 26 July 2026. The supplier's proof comes back as a reply on that
-- thread, which fires `convo.customer.reply.created` at our own webhook. We were
-- simply not listening: `helpscout-webhook` matched conversations only against
-- proofs.helpscout_conversation_id, found no proof, and dropped the event. 62 such
-- replies had already arrived and been discarded when this was written.
--
-- Measured on those 46 orders: median reply lag 2.0 hours, mean 6.2; every order
-- got a reply; none has ever gone two days silent. Hence a default threshold of
-- ONE working day, which is generous rather than twitchy.
--
-- ── Deliberately NOT a new order status ──────────────────────────────────────
-- `fulfilled` means "placed into production" and is read by src/lib/orderLog.ts,
-- src/lib/reorderDesk.ts, src/lib/dashboardGrouping.ts, ReprintModal, the
-- ProofDetailPage reopen gating, OrderPayPage and the customer tracking
-- projection. Adding an `awaiting_supplier_proof` status would silently move all
-- of them — the drift that 000245 / 000246 / 000279 each had to be written to
-- undo. The pen is an OVERLAY on a placed order: money, production, Stock Control
-- and everything the customer sees are untouched by this migration.
--
-- ── The one rule ─────────────────────────────────────────────────────────────
--   needs checking when  supplier_reply_at > supplier_proof_approved_at
-- A comparison rather than a flag, because QX routinely sends an UPDATED proof
-- hours after the first ("Sorry, please find the updated proof attached") —
-- sometimes after we have already approved. Because the question is "has anything
-- arrived SINCE we signed off?", a late correction simply re-flags the card and
-- cannot be silently swallowed. The client twin of this rule, with the state
-- machine and its property tests, is src/lib/supplierProof.ts.
--
-- Scope note: the frontend decides membership from `supplier_email_sent_at`, NOT
-- from the material's production_route — that is what correctly excludes a
-- blanks-sourced order (000382), which has a supplier material but deliberately
-- sends no supplier email, so no proof is ever coming.

-- No explicit begin/commit: apply_migration wraps the whole file in one
-- transaction, matching every other migration in this repo.

-- ── 1. The two stamps, and who signed off ───────────────────────────────────

alter table proofs.orders
  add column if not exists supplier_reply_at           timestamptz,
  add column if not exists supplier_proof_approved_at  timestamptz,
  add column if not exists supplier_proof_approved_by  uuid references auth.users(id) on delete set null;

comment on column proofs.orders.supplier_reply_at is
  'Newest supplier reply on supplier_helpscout_conversation_id, stamped by the helpscout-webhook edge function on CUSTOMER-direction replies only. Compared against supplier_proof_approved_at to decide whether a placed supplier order needs a human (see src/lib/supplierProof.ts).';
comment on column proofs.orders.supplier_proof_approved_at is
  'When a human approved the supplier''s internal proof. Written by the approve-supplier-proof edge function AFTER its reply to the supplier has posted — never before, or a failed send would clear the card off the page while the supplier waited.';

-- ── 2. The webhook's lookup key ─────────────────────────────────────────────
-- `helpscout-webhook` now resolves an inbound reply against this column on every
-- supplier conversation. There was no index on it at all — the proof lookup has
-- always had one, this path never existed.

create index if not exists orders_supplier_helpscout_conversation_id_idx
  on proofs.orders (supplier_helpscout_conversation_id)
  where supplier_helpscout_conversation_id is not null;

-- ── 3. Admin-editable threshold ─────────────────────────────────────────────
-- Working days of silence before an unanswered supplier order reads as a problem
-- rather than as normal waiting. Editable under Admin → Settings → Ordering &
-- checkout so the number can move without a redeploy — the same treatment
-- order_reminders_max / order_reminder_interval_days got in 000270.

alter table proofs.settings
  add column if not exists supplier_proof_overdue_days smallint not null default 1
    constraint settings_supplier_proof_overdue_days_range check (supplier_proof_overdue_days between 1 and 30);

comment on column proofs.settings.supplier_proof_overdue_days is
  'Working days of supplier silence after a placed supplier order before it escalates from Waiting to Fix on the Orders page. Default 1: measured median reply lag is 2 hours.';

-- ── 4. The reply we send back ────────────────────────────────────────────────
-- Resolved most-specific-first by the approve-supplier-proof edge function:
--   supplier_proof_approval:<supplier_id>  →  supplier_proof_approval
-- exactly as `supplier_order_email` already is (three live per-supplier rows).
--
-- ⚠ The three suppliers send back three DIFFERENT things, which is why each gets
-- its own body rather than sharing one. Read off the live threads 2026-08-12:
--
--   QX Metals  an artwork proof for approval ("Please find the proof attached
--              for your confirmation"). The only one that is really a proof.
--   Solopress  a booking confirmation and their own job number ("All booked in
--              — 5436477"). Nothing to approve.
--   Swype      a proforma invoice, and they do not start until it is paid
--              ("Once payment has been received, I can put into production").
--
-- So the SHARED default is deliberately vague and the specific wording lives on
-- the overrides. A shared "the proof is approved, please go ahead and produce the
-- order" would have told Swype to start printing something they are waiting to be
-- paid for — and a future supplier we know nothing about would get the same.
--
-- Nothing parses any of these; unlike `supplier_order_email` there is no
-- machine-readable block, so the wording belongs entirely to whoever edits it.
-- House seed pattern (000157 / 000207 / 000260 / 000311 / 000366): `on conflict
-- do nothing` so an admin-edited body is never clobbered on replay, and every
-- body mirrors DEFAULT_BODIES in src/lib/replyTemplates.ts byte for byte so the
-- editor's "Reset to default" restores the text that was actually shipped.
--
-- Real newlines below, not E'' escape strings, so src/lib/supplierProofTemplate.test.ts
-- can extract each literal and compare it byte-for-byte (the 000366 pattern).

insert into proofs.reply_templates (id, display_name, description, body)
values
  (
    'supplier_proof_approval',
    'Supplier reply — acknowledgement',
    'The fallback reply sent to a supplier when we clear their response to a placed order. Deliberately says nothing specific: suppliers that send something specific (a proof, a booking, a proforma) get their own version below.',
    'Hi,

Thanks — that''s noted and confirmed our end.

Many thanks.'
  ),
  (
    'supplier_proof_approval:91eac49d-cea7-44c7-bbcf-974425d26dc7',
    'Supplier reply — QX Metals (proof approved)',
    'Sent to QX Metals when we approve the artwork proof they returned for a placed order.',
    'Hi,

Thanks — the proof is approved. Please go ahead and produce the order.

Many thanks.'
  ),
  (
    'supplier_proof_approval:ca962788-025e-41ca-b7d5-7a00b2a103db',
    'Supplier reply — Solopress (booking confirmed)',
    'Sent to Solopress when we clear their booking confirmation. They do not send a proof, so there is nothing to approve — this just closes the loop.',
    'Hi,

Thanks for confirming — all noted our end.

Many thanks.'
  ),
  (
    'supplier_proof_approval:e9494599-a82a-4ccb-ae12-9428c9414fed',
    'Supplier reply — Swype (proforma received)',
    'Sent to Swype when we clear their proforma invoice. Deliberately promises nothing about payment or about going ahead: Swype do not start until the proforma is paid, and that payment is handled outside this app.',
    'Hi,

Thanks — received and noted. We''ll come back to you on the proforma.

Many thanks.'
  )
on conflict (id) do nothing;

-- ── 5. Keep the pay pages sealed ────────────────────────────────────────────
-- House rule from 000365: any new proofs.orders column a pay-link holder must not
-- see goes on the strip list in the SAME migration that adds the column. The
-- supplier's reply timing and our internal sign-off are production internals —
-- they sit alongside supplier_name / supplier_email_sent_at, already stripped.
--
-- ⚠ Body below is the LIVE definition read from pg_get_functiondef on 2026-08-12
-- (which already carries 000384's ship_dest_ack strip), plus the three new lines.
-- Never rebuild this from an older migration file: doing exactly that is how the
-- strip list was silently lost twice (000230→000265, 000268→000309).

create or replace function proofs._customer_order_json(o proofs.orders)
returns jsonb
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  select (to_jsonb(o)
            - 'token'
            -- Production / supplier internals
            - 'stock_order_number'
            - 'supplier_id'
            - 'supplier_name'
            - 'supplier_helpscout_conversation_id'
            - 'supplier_overs'
            - 'supplier_email_sent_at'
            -- Supplier proof holding pen (000409): when their proof came back,
            -- and who here signed it off. Internal production correspondence.
            - 'supplier_reply_at'
            - 'supplier_proof_approved_at'
            - 'supplier_proof_approved_by'
            - 'dropbox_folder_url'
            - 'stock_colour'
            - 'date_required'
            - 'project_name'
            - 'production_note_posted_at'
            - 'handoff_at'
            - 'handoff_payload'
            - 'handoff_error'
            -- AI artwork check (report quotes Help Scout thread content)
            - 'artwork_check'
            - 'artwork_checked_at'
            - 'artwork_check_verdict'
            - 'artwork_check_running_at'
            -- Internal hold: the reason is a staff note about the customer,
            -- and the flag snapshot carries artwork-check report text.
            - 'held_at'
            - 'hold_reason'
            - 'held_by'
            - 'held_by_name'
            - 'hold_artwork_flag'
            -- Xero / invoicing internals
            - 'xero_invoice_id'
            - 'xero_invoice_error'
            - 'xero_contact_id'
            - 'xero_contact_name'
            - 'invoice_emailed_at'
            - 'confirmation_sent_at'
            -- Staff attribution + internal notes / refs / telemetry
            - 'created_by'
            - 'fulfilled_by'
            - 'card_discount_reason'
            - 'reprint_of_order_id'
            - 'blanks_source_order_id'
            - 'shipping_discount_percent'
            - 'pay_link_opened_at'
            -- Delivery-postcode mismatch ack (000384): internal record of the
            -- gate having fired; the pages never read it back
            - 'ship_dest_ack'
            -- Recipient contact details Stripe collected — shown nowhere on
            -- the pay pages, so they don't ride a forwardable link
            - 'ship_to_email'
            - 'ship_to_phone')
         || jsonb_build_object(
              'order_spec_snapshot',
              case
                when jsonb_typeof(o.order_spec_snapshot) = 'object'
                  then o.order_spec_snapshot - 'contact' - 'company' - 'captured_by'
                else null
              end
            )
$function$;

comment on function proofs._customer_order_json(proofs.orders) is
  'Serialises an order for the anon pay pages with every internal column stripped. BOTH public_get_order and public_get_order_group must go through this — never a bare to_jsonb(o) - ''token'' (000365). Any new internal column goes on the strip list in the same migration that adds it.';

-- ── 6. Backfill: start clean ────────────────────────────────────────────────
-- Every supplier order placed before today is stamped as already approved.
--
-- We have no record of which of them were really approved — the approval has only
-- ever existed as a message in Help Scout — so the alternative is opening day one
-- with ~46 stale cards demanding attention for work that was finished weeks ago.
-- A worklist that is wrong the first time you look at it does not get looked at
-- again. The feature therefore governs orders placed from now on.
--
-- fulfilled_at (not now()) so the timeline reads honestly: these were signed off
-- around the time they were placed, not retrospectively today.

update proofs.orders
   set supplier_proof_approved_at = fulfilled_at
 where status = 'fulfilled'
   and supplier_email_sent_at is not null
   and supplier_helpscout_conversation_id is not null
   and supplier_proof_approved_at is null
   and fulfilled_at is not null;

