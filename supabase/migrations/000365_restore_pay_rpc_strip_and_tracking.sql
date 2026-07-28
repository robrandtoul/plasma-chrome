-- 000365 — re-seal the pay-page RPCs and revive customer order tracking.
--
-- Migration 000309 (order groups) re-emitted proofs.public_get_order as a
-- plain `to_jsonb(o) - 'token'` and created public_get_order_group the same
-- way — silently discarding BOTH protections that 000265/000268 had built:
--
--   1. The internal-field strip list. Since 2026-07-08, anyone holding a pay
--      link has been able to see the order's Stock Control number, supplier
--      id/name, supplier Help Scout conversation id, Dropbox folder URL, the
--      full AI artwork-check report (which quotes Help Scout thread content),
--      Xero invoice/contact bindings and error text, staff UUIDs, and every
--      internal column added since. Contained — each token only reaches its
--      own order — but none of it belongs on a customer surface.
--
--   2. The `tracking_projection` key. The customer tracking panel on the pay
--      page reads it (OrderPayPage renderStatusBlock), the master switch has
--      been ON with both routes at 'broad', and the 000269 projection helper
--      survived on live fully intact — but the RPC stopped calling it, so the
--      panel silently vanished (`!p → return null`, no error anywhere).
--
-- The fix keeps the SUBTRACTIVE whole-row shape (an allow-list rebuild could
-- accidentally drop a field the pay pages consume; subtraction can only
-- remove the named internals) but moves the strip into ONE shared helper
-- that BOTH RPCs call — the 000309 regression happened precisely because the
-- strip list lived inline in a function body that got re-emitted from an
-- older template. ⚠ HOUSE RULE, LEARNED TWICE (000230→000265, 000268→000309):
-- any future re-emit of public_get_order or public_get_order_group MUST keep
-- serialising order rows through proofs._customer_order_json(), and anything
-- added to proofs.orders that a customer must not see MUST be added to the
-- strip list there.
--
-- Strip-list derivation (2026-07-28): the ONLY runtime consumers of these
-- RPCs are OrderPayPage (public_get_order) and OrderGroupPayPage
-- (public_get_order_group) — verified by repo-wide grep. Every stripped
-- field below was checked against both pages' exact consumed-field lists;
-- none is read from the RPC payloads (their staff-side consumers all use
-- direct authenticated table selects or service-role edge functions).
-- Deliberately KEPT, because a pay page reads them: previous_spec (000364
-- guidance, customer-safe by its server-side allow-list sanitiser),
-- order_spec_snapshot (group page card labels — but see the sub-strip
-- below), card_discount_type/value, order_kind, all amount_*, the open-spec
-- flags, ship_to_name/ship_to_address, customs_tax_id, order_group_id.
-- Neutral operational timestamps (sent_at, paid_at, fulfilled_at, created_at,
-- updated_at, revised_at, help_requested_at) and payment_method stay too —
-- harmless, and paid_at is declared on the page interface.
--
-- order_spec_snapshot sub-strip: the snapshot the group page labels cards
-- from also froze the proof contact's name + email and the capturing staff
-- UUID (buildOrderSpecSnapshot's contact/company/captured_by keys). The page
-- reads only material/variant/finish/quantity, so the personal keys are
-- removed from the wire copy; the stored column is untouched.

-- ── The single serialiser both RPCs must use ─────────────────────────────
-- Pure jsonb maths over one orders row; no table reads. STABLE, not
-- immutable — to_jsonb renders the row's timestamptz columns via the session
-- TimeZone, which immutability would misclaim. EXECUTE revoked below
-- (internal plumbing, not API surface): the proofs schema has no default
-- function ACL, so without the revoke PostgREST would offer any new function
-- to anon (the 000356 lesson) — the SECURITY DEFINER RPCs run as the owner,
-- so they keep calling it regardless.
create or replace function proofs._customer_order_json(o proofs.orders)
returns jsonb
language sql
stable
set search_path = proofs, public, extensions, pg_temp
as $$
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
            - 'shipping_discount_percent'
            - 'pay_link_opened_at'
            -- Recipient contact details Stripe collected — shown nowhere on
            -- the pay pages, so they don't ride a forwardable link
            - 'ship_to_email'
            - 'ship_to_phone')
         || jsonb_build_object(
              'order_spec_snapshot',
              -- Gate on jsonb_typeof, not IS NULL: '-' on a non-object jsonb
              -- raises "cannot delete from scalar", which would error the
              -- whole RPC for that order. Both writers only ever emit objects
              -- (and live data is 100% objects/SQL-NULL today), but the
              -- column is authenticated-writable under RLS, so a poisoned
              -- value must degrade to null — the pages optional-chain every
              -- read — rather than take the pay page down.
              case
                when jsonb_typeof(o.order_spec_snapshot) = 'object'
                  then o.order_spec_snapshot - 'contact' - 'company' - 'captured_by'
                else null
              end
            )
$$;

revoke execute on function proofs._customer_order_json(proofs.orders)
  from public, anon, authenticated;

comment on function proofs._customer_order_json(proofs.orders) is
  'The ONLY serialisation of a proofs.orders row that may reach a customer (public_get_order + public_get_order_group). Any new orders column a customer must not see goes on the strip list HERE. Never bypass with a bare to_jsonb(o) — that exact shortcut leaked internals twice (000230→000265, 000268→000309). See migration 000365.';

-- ── public_get_order — 000268 shape + 000309's order_group_status ────────
-- plpgsql exactly like the last-good 000268 version: fetch the row, compute
-- the tracking projection via the surviving 000269 helper (settings-gated
-- server-side; emits {'level':'off'} whenever disclosure says no), then
-- serialise through the shared strip.
create or replace function proofs.public_get_order(p_order_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  o      proofs.orders;
  v_proj jsonb;
begin
  select * into o from proofs.orders
   where id = p_order_id and token = p_token;
  if not found then return null; end if;

  v_proj := proofs._project_order_tracking(o.stock_order_number, o.proof_id, o.status);

  return proofs._customer_order_json(o)
         || jsonb_build_object(
              'tracking_projection', v_proj,
              'order_group_status',
              (select g.status from proofs.order_groups g where g.id = o.order_group_id)
            );
end;
$$;

revoke all on function proofs.public_get_order(uuid, text) from public;
grant execute on function proofs.public_get_order(uuid, text) to anon, authenticated;

comment on function proofs.public_get_order(uuid, text) is
  'Anon pay-page read (token-gated). MUST serialise the order through proofs._customer_order_json() and keep the tracking_projection + order_group_status keys — a re-emit from an older template that reverts to bare to_jsonb(o) re-leaks internals and silently kills the customer tracking panel (happened twice: 000230→000265, 000268→000309; fixed in 000365).';

-- ── public_get_order_group — member rows through the same strip ──────────
-- The group row itself gets its own subtraction (order_groups has no
-- production columns, but it does carry Xero bindings, done-once webhook
-- flags, a staff UUID, the goodwill percentage, and the recipient's
-- email/phone — none of which OrderGroupPayPage reads). company_name and
-- the member ordering are unchanged from 000309. No tracking projection
-- here: the group page renders none (per-order tracking appears on each
-- member's own /order/:id page once paid).
create or replace function proofs.public_get_order_group(p_group_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'group', to_jsonb(g)
               - 'token'
               - 'xero_contact_id'
               - 'xero_contact_name'
               - 'xero_invoice_id'
               - 'xero_invoice_error'
               - 'invoice_emailed_at'
               - 'confirmation_sent_at'
               - 'created_by'
               - 'shipping_discount_percent'
               - 'pay_link_opened_at'
               - 'ship_to_email'
               - 'ship_to_phone',
    'orders', coalesce(
      (
        select jsonb_agg(proofs._customer_order_json(o) order by o.created_at, o.id)
        from proofs.orders o
        where o.order_group_id = g.id
      ),
      '[]'::jsonb
    ),
    'company_name', (
      select coalesce(co.name, c.full_name)
      from proofs.orders o2
      join proofs.proofs p on p.id = o2.proof_id
      left join proofs.contacts c on c.id = p.contact_id
      left join proofs.companies co on co.id = c.company_id
      where o2.order_group_id = g.id
      order by o2.created_at, o2.id
      limit 1
    )
  )
  from proofs.order_groups g
  where g.id = p_group_id
    and g.token = p_token;
$$;

revoke all on function proofs.public_get_order_group(uuid, text) from public;
grant execute on function proofs.public_get_order_group(uuid, text) to anon, authenticated;

comment on function proofs.public_get_order_group(uuid, text) is
  'Anon combined-payment page read (token-gated). MUST serialise member rows through proofs._customer_order_json() and keep the group-row strip — a re-emit with bare to_jsonb leaks Xero bindings, staff ids and recipient contact details to pay-link holders (see 000365).';
