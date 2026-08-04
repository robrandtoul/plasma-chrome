-- 000382: "base cards supplied under another order's batch" — the column.
--
-- Two paid orders for the same base card (the driving case: two dental
-- practices of one umbrella company, plain black paper blanks foiled in-house)
-- are much cheaper as ONE combined supplier batch. One order carries the whole
-- batch via its Spoilage overs; the other points here — place-order then hands
-- it off IN-HOUSE (the finishing job, with a provenance line naming the batch)
-- and sends NO supplier email. See 000383 for the create_order_handoff side.
--
-- `blanks_source_order_id` = the sibling proofs.orders row whose supplier
-- batch covers this order's base cards. Stamped by place-order at confirm
-- (service role); the frontend never writes it. ON DELETE SET NULL so deleting
-- a project (delete_proof_cascade → orders cascade) can't be blocked by a
-- sibling's provenance pointer.
--
-- ⚠ Pay-page strip list (the 000365 rule, stamped as comments on the live
-- functions): every new proofs.orders column a customer must not see goes onto
-- proofs._customer_order_json's strip list IN THE SAME MIGRATION. This is an
-- internal provenance pointer (another customer's order id), so it is stripped.
-- The helper below is re-emitted from the LIVE pg_get_functiondef (read
-- 2026-08-04) with exactly one line added, under the staff-internals group.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP
-- apply_migration / dashboard SQL editor per the house workflow — never CLI
-- push. Apply BEFORE deploying the updated place-order function (it selects
-- the new column — tolerantly, but the feature stays hidden until this lands).

alter table proofs.orders
  add column if not exists blanks_source_order_id uuid
    references proofs.orders(id) on delete set null;

comment on column proofs.orders.blanks_source_order_id is
  'Combined supplier batches (000382): the sibling order whose supplier batch (its quantity + spoilage overs) covers this order''s base cards. When set at placement, place-order hands this order off in-house (the finishing job, with a provenance note) and sends no supplier email. Stamped by place-order at confirm; null = this order buys its own blanks.';

-- Re-emit the pay-page serialisation helper with the new column stripped.
-- Base: live pg_get_functiondef, 2026-08-04. One added line, marked NEW.
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
            - 'blanks_source_order_id'  -- NEW (000382): sibling-order provenance pointer
            - 'shipping_discount_percent'
            - 'pay_link_opened_at'
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

-- create or replace preserves the existing ACL + comment; the revoke is
-- restated anyway per the house pattern (idempotent, and load-bearing if this
-- ever replays onto a fresh database where the default would be PUBLIC).
revoke all on function proofs._customer_order_json(proofs.orders) from public, anon, authenticated;
