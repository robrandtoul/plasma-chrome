-- 000377 — put a paid order on hold while a question is out with the customer.
--
-- THE GAP. The artwork check catches something that needs clearing with the
-- customer, but the order carries on sitting in Place looking exactly like one
-- nobody has got round to yet. Any of five staff can push it to production
-- while the person who raised the query is waiting on a reply, and once that
-- happens there is no recall: place-order writes the Stock Control job and then
-- emails the supplier, and its own re-send guard refuses a second attempt
-- precisely because the first cannot be taken back.
--
-- WHERE THE BLOCK LIVES. Three layers, and only the outermost is UI:
--   1. the Orders page / review page refuse to offer the action;
--   2. `place-order` returns 409 order_on_hold before anything irreversible;
--   3. THIS trigger, which is the one that actually makes it a control rather
--      than a hint — it catches a crafted REST call, a hand-run SQL update, and
--      any future code path that flips the status without knowing holds exist.
-- `settings.direct_handoff_mode` is 'live', so placement runs through
-- public.create_order_handoff, which writes the Stock Control job BEFORE the
-- supplier email and whose exception handler wraps only the uuid casts at the
-- top — so a raise here propagates and rolls the whole transaction back,
-- taking the job row with it. Nothing is half-placed.
--
-- WHAT THIS DELIBERATELY DOES NOT COVER. A hand-written Help Scout note
-- carrying Qty:/Card: lines still creates a Stock Control job via the
-- `helpscout-inhouse-order` parser, which is a deliberate backstop (see
-- docs/order-handoff-stock-control-changes.md). That path never touches an
-- order row, so no control ON an order can close it. The UI copy is worded
-- accordingly — it never claims "nobody can place this".
--
-- NO NEW STATUS, ON PURPOSE. An eighth value on orders_status_check would drop
-- held orders out of the Orders page's `.in('status', [...])` fetch and out of
-- every section predicate — the order would vanish from the queue while
-- remaining blocked, which is the worst possible failure for this feature.
-- A hold is a flag ON a paid order, not a state instead of one.

-- ── The hold itself ────────────────────────────────────────────────────────
-- Columns on `orders` rather than a side table: they ride the page's existing
-- single fetch, so there is never a moment where a held card has rendered but
-- its hold has not loaded yet and the place button is live. They also inherit
-- the existing `orders_rw` policy, so there is no new grant matrix to get wrong.
alter table proofs.orders
  add column if not exists held_at timestamptz,
  add column if not exists hold_reason text,
  add column if not exists held_by uuid references proofs.profiles(id) on delete set null,
  add column if not exists held_by_name text,
  -- What the artwork check said at the moment the hold was raised. Snapshotted
  -- because `orders.artwork_check` is overwritten wholesale by every re-run —
  -- and the 000337 trigger auto-fires one whenever dropbox_folder_url is
  -- written — so without this the reason outlives the finding that caused it.
  add column if not exists hold_artwork_flag jsonb;

comment on column proofs.orders.held_at is
  'When this order was put on hold pending a customer answer. Non-null = blocked from placement by orders_hold_guard(). Cleared by a person, or automatically when the order moves to revision.';
comment on column proofs.orders.held_by_name is
  'Display name of whoever held it, denormalised because proofs.profiles SELECT is self-or-admin — a live join renders nothing for a colleague reading your hold. Stamped server-side by orders_hold_guard(), never client-supplied.';

-- A hold with no stated reason is useless: a colleague who finds a blocked
-- order cannot tell whether to wait or to take it off, which is the whole job.
alter table proofs.orders
  drop constraint if exists orders_hold_shape_check;
alter table proofs.orders
  add constraint orders_hold_shape_check check (
    (held_at is null and hold_reason is null)
    or (held_at is not null and char_length(btrim(hold_reason)) between 1 and 500)
  ) not valid;
alter table proofs.orders validate constraint orders_hold_shape_check;

-- ── The guard ──────────────────────────────────────────────────────────────
-- One BEFORE trigger doing four jobs, because they have to agree with each
-- other and because the ordering between them is load-bearing.
--
-- NOTE this is the FIRST 'before' trigger on proofs.orders (the four existing
-- ones — notify_artwork_check_on_folder_link, notify_push_on_order_paid,
-- notify_push_on_pay_link_opened, orders_clear_link_note — are all AFTER), so
-- it cannot disturb their ordering.
create or replace function proofs.orders_hold_guard()
returns trigger
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_name text;
begin
  -- (1) THE BLOCK. Read OLD.held_at, never NEW: a single crafted statement
  -- that clears the hold and sets status='fulfilled' at once must still be
  -- refused, and only the OLD value can tell us the order was held when the
  -- statement began.
  --
  -- Scoped to the transition INTO fulfilled. An order already in production
  -- must stay updatable — the workshop-note re-send path patches a fulfilled
  -- row, and re-gating that would strand a job the supplier was never told
  -- about.
  if tg_op = 'UPDATE'
     and old.held_at is not null
     and new.status = 'fulfilled'
     and old.status is distinct from 'fulfilled' then
    raise exception
      'This order is on hold: % (put on hold by % on %). Take it off hold before placing it.',
      coalesce(old.hold_reason, 'no reason recorded'),
      coalesce(old.held_by_name, 'a colleague'),
      to_char(old.held_at at time zone 'Europe/London', 'FMDD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  -- (2) A HOLD ONLY MEANS ANYTHING ON A PAID ORDER, SO LEAVING `paid` ENDS IT.
  --
  -- The case this is really for: the customer confirms the artwork IS wrong,
  -- the card gets redesigned, and the order moves paid -> revision. The hold's
  -- question has been answered and `revision` is itself now the thing stopping
  -- production, so keeping the hold would mean two blocks on one order and a
  -- second thing to remember. Rob's call, 2026-08-02.
  --
  -- Written as "any status other than paid" rather than "revision" on purpose,
  -- because it also closes the strand: cancelled rows are never fetched by the
  -- Orders page (`.in('status', [sent, paid, fulfilled, revision])`), so a hold
  -- surviving a cancellation would be invisible AND unreachable forever. It
  -- can never fire on the fulfilled transition — branch (1) has already raised
  -- by then.
  --
  -- In the trigger rather than in order-lifecycle so it holds for every route
  -- out of paid, including a hand-run update.
  if tg_op = 'UPDATE'
     and new.status is distinct from old.status
     and new.status <> 'paid'
     and old.held_at is not null then
    new.held_at := null;
  end if;

  -- (3) ATTRIBUTION. Stamped here, not by the client: proofs.profiles SELECT
  -- is self-or-admin, so the frontend cannot read a colleague's name to write
  -- it, and a client-supplied name would be spoofable on a shared row. Same
  -- idiom as feedback_items_set_author (000271) and order_link_notes (000296).
  --
  -- auth.uid() is null for service-role callers (edge functions); the columns
  -- stay null rather than inventing an author.
  if new.held_at is not null
     and (tg_op = 'INSERT' or old.held_at is null) then
    new.held_by := auth.uid();
    if new.held_by is not null then
      select full_name into v_name from proofs.profiles where id = new.held_by;
      new.held_by_name := v_name;
    end if;
  end if;

  -- (4) RELEASE NORMALISATION. Clearing held_at alone would violate
  -- orders_hold_shape_check, so a caller would have to know to null four
  -- columns in one patch — and the optimistic local patch the Orders page does
  -- would leave the card looking released while the write bounced. Instead,
  -- nulling held_at IS the release, and the rest follows automatically. This
  -- also finishes the job for branch (2).
  if new.held_at is null then
    new.hold_reason := null;
    new.held_by := null;
    new.held_by_name := null;
    new.hold_artwork_flag := null;
  end if;

  return new;
end;
$$;

-- The proofs schema has no pg_default_acl for functions, so a new function is
-- born EXECUTE TO PUBLIC. Triggers fire regardless of EXECUTE, so revoking
-- costs nothing and keeps it off the callable API surface (the 000182 rule).
revoke execute on function proofs.orders_hold_guard() from public, anon, authenticated;

drop trigger if exists orders_hold_guard on proofs.orders;
create trigger orders_hold_guard
  before insert or update on proofs.orders
  for each row execute function proofs.orders_hold_guard();

-- ── Keep the hold off the customer's pay page ──────────────────────────────
-- Both pay-page RPCs serialise every order row through this helper, so adding
-- the five columns here is the whole fix (that is why 000365 exists). The
-- reason text is an INTERNAL note — it will contain things like "customer has
-- spelled their own name wrong" — and must never reach a pay-link holder.
--
-- Body below is the LIVE pg_get_functiondef read on 2026-08-02, plus the five
-- new strips. Never rebuild this from an older migration file: whatever was
-- added to the strip list since would be silently dropped.
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
$function$;

comment on function proofs._customer_order_json(proofs.orders) is
  'Single strip list for BOTH pay-page RPCs (public_get_order, public_get_order_group). Any new proofs.orders column a customer must not see goes on this list in the SAME migration that adds the column. Never serialise order rows with a bare to_jsonb(o) - ''token'' — that regression shipped twice (000230->000265, 000268->000309).';
