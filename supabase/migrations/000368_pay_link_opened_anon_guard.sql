-- 000368 — only a CUSTOMER open counts as "the customer opened it".
--
-- proofs.record_order_pay_link_opened (single orders) has always ended with
-- `and auth.uid() is null`, so a signed-in designer opening a pay link is a
-- silent no-op and the stamp means what it says. Its two siblings never got
-- that line:
--
--   * record_order_group_pay_link_opened (000309, combined payments)
--   * record_proof_set_opened            (000311, bundle review front door)
--
-- Both are reached from pages staff open routinely — the Orders page hands
-- out "Copy combined link", and the bundle workspace has an explicit
-- "Preview customer view" button — so every staff visit has been writing a
-- customer-open stamp. SetReviewPage's own call site even documents the
-- intent it doesn't have: "mirrors record_order_pay_link_opened on
-- OrderPayPage" (src/pages/SetReviewPage.tsx). It didn't.
--
-- Why this matters more than a cosmetic wrong timestamp: these stamps are
-- the ONLY "has the customer seen it" signal for a grouped order. The
-- members' own stamps stay frozen while grouped (their links are dormant),
-- so the Orders page renders the group's stamp alone — see the comment on
-- OrdersPage's group header, "the only honest 'has the customer seen it'
-- signal". A designer checking their own link flips that from "pay link not
-- opened yet" to "pay link opened just now", which reads as the customer
-- being engaged and is the exact opposite of the truth. Observed live on
-- 2026-07-30: group GRP-DA935E9944 read as opened 11 seconds after it was
-- created, which was staff, not the customer.
--
-- Note this is a live-data *diagnosis* aid, not a security control — the
-- guard removes accidental staff writes, and the grants below are unchanged
-- (both functions stay callable by anon AND authenticated, exactly as the
-- already-guarded single-order function does; the body, not the ACL, is
-- what makes a staff call a no-op).
--
-- Both are CREATE OR REPLACE with identical signatures, so grants survive;
-- they are re-stated anyway per the house convention in 000365, along with
-- a comment on function recording the rule for the next person who
-- re-emits one of these.
--
-- Deliberately NOT touched: proofs.record_proof_view. The designer-preview
-- bypass for proof views is handled client-side instead (the ?preview=1
-- flag in src/lib/customerProofUrl.ts, which skips the RPC entirely), and
-- that mechanism is load-bearing for the needs-attention rules. Moving it
-- server-side is a separate decision, not a drive-by.

-- ── Combined payments (000309) ───────────────────────────────────────────
create or replace function proofs.record_order_group_pay_link_opened(
  p_group_id uuid,
  p_token    text
)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  update proofs.order_groups
     set pay_link_opened_at = now()
   where id     = p_group_id
     and token  = p_token
     and status = 'sent'
     -- Customer opens only: a signed-in designer following the combined
     -- link (Orders page "Copy combined link", or checking a customer
     -- report) must not masquerade as the customer. Mirrors
     -- record_order_pay_link_opened.
     and auth.uid() is null;
$function$;

revoke all on function proofs.record_order_group_pay_link_opened(uuid, text) from public;
grant execute on function proofs.record_order_group_pay_link_opened(uuid, text) to anon, authenticated;

comment on function proofs.record_order_group_pay_link_opened(uuid, text) is
  'Stamps order_groups.pay_link_opened_at on a genuine customer open. The '
  '`auth.uid() is null` guard is load-bearing: a grouped member''s own stamp '
  'stays frozen while grouped, so this is the only "has the customer seen '
  'it" signal the Orders page can show. Keep the guard on any re-emit '
  '(000368).';

-- ── Bundle review front door (000311) ────────────────────────────────────
create or replace function proofs.record_proof_set_opened(
  p_set_id uuid,
  p_token  text
)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  update proofs.proof_sets
     set last_opened_at = now()
   where id      = p_set_id
     and token   = p_token
     -- Membership lock: a bundle that hasn't been announced can't have been
     -- opened by the customer (000311).
     and sent_at is not null
     -- Customer opens only — the bundle workspace's "Preview customer view"
     -- button lands a designer on this exact page.
     and auth.uid() is null;
$function$;

revoke all on function proofs.record_proof_set_opened(uuid, text) from public;
grant execute on function proofs.record_proof_set_opened(uuid, text) to anon, authenticated;

comment on function proofs.record_proof_set_opened(uuid, text) is
  'Stamps proof_sets.last_opened_at on a genuine customer open. Guarded with '
  '`auth.uid() is null` so the workspace''s "Preview customer view" button '
  'does not read as the customer opening the bundle. Keep the guard on any '
  're-emit (000368).';
