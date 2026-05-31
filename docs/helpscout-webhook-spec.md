# Help Scout → proof-viewer activity sync (webhook)

Status: **building** (reply-activity sync). Tag sync (Phase 2b) still deferred.

## Why

Needs-attention is computed entirely from proof-viewer's own signals (did the
customer open the proof, approve, request changes; time since activity; status).
It has **no inbound awareness of Help Scout** — no webhook, no polling. So a
chase done directly in Help Scout (or a customer reply by email) is invisible,
and the proof stays flagged until the customer acts *in the proof* or the
designer uploads a version / changes status / snoozes it.

This feature gives proof-viewer an inbound signal: when a reply happens on the
linked Help Scout conversation, quiet the Needs-attention flag for a grace
window.

## Decisions (locked)

- **Suppression: timestamp guard** (Option A). Stamp the proof with the last
  Help Scout reply time; `proofs_needing_attention()` skips it for the grace
  window, then it auto-returns if still unactioned. Chosen over auto-snooze
  because it is self-clearing, rule-agnostic, keeps tile counts and the list in
  step, and leaves no phantom "snoozed by nobody" rows.
- **Customer replies also suppress.** Both staff (`agent.reply`) and customer
  (`customer.reply`) replies count as activity.
- **Applies to the four chase rules only**: `sent_never_viewed`,
  `viewed_not_actioned`, `approaching_dormant`, `stuck_in_progress`. NOT
  `request_changes_no_version` (chasing doesn't discharge owing a new version).
- **Tag sync deferred.** `convo.tags` → `proofs.helpscout_tags` (the dormant
  Phase 2b `helpscout_follow_up_tag` rule) is a later pass.

## Help Scout side (manual config)

Register a webhook on the existing Help Scout app pointing at the
`helpscout-webhook` edge function URL. Subscribe to:
- `convo.agent.reply.created`
- `convo.customer.reply.created`

Store the webhook signing secret as the `HELPSCOUT_WEBHOOK_SECRET` function
secret. (Confirm exact event names + signature header against current Help Scout
webhook docs; the receiver assumes `X-HelpScout-Signature` = base64 HMAC-SHA1 of
the raw body.)

## Receiver — `supabase/functions/helpscout-webhook`

Public endpoint (`verify_jwt = false`). Flow:
1. Verify HMAC-SHA1 signature against `HELPSCOUT_WEBHOOK_SECRET` over the raw
   body; mismatch → 401.
2. Parse conversation id + event type.
3. `select id from proofs where helpscout_conversation_id = <id>`; no match →
   200 (ignore — most HS conversations aren't proofs).
4. Service-role update of the matched proof(s), `helpscout_*` columns only:
   - agent reply → `helpscout_last_reply_at = now()`
   - customer reply → `helpscout_last_customer_reply_at = now()`
5. Return 200 fast (HS retries on 5xx).

Idempotent (writes are "set to now"), no echo/loop (proof-viewer's own send
fires `agent.reply` → just stamps the column, no re-send).

## Data model (migration 000208)

On `proofs`:
- `helpscout_last_reply_at timestamptz` — last outbound staff reply.
- `helpscout_last_customer_reply_at timestamptz` — last inbound customer reply.

Setting (`site_settings.needs_attention_rules.helpscout_reply_grace_days`,
default 3) — the grace window. Read via `coalesce(..., 3)`; an admin card for it
is a future nicety (edit via DB for now).

## Rule guard

`proofs_needing_attention()` final select adds: suppress a flagged proof when its
rule is one of the four chase rules AND
`greatest(helpscout_last_reply_at, helpscout_last_customer_reply_at) >= now() -
grace_days`. The dashboard view + tile counts derive from this function, so they
update for free.

`public_dashboard_projects` exposes both timestamps (for the "Chased / Customer
replied Nd ago" chip).

## Frontend

A muted chip on the dashboard row when there's recent Help Scout activity:
"Chased Nd ago" (staff) or "Customer replied Nd ago" (customer), so a suppressed
proof doesn't just silently vanish.

## Security

- HMAC signature verified before any work; 401 otherwise.
- Service-role writes scoped to `helpscout_*` columns on the matched proof.
- Empty 200 responses (no data leak).
- `verify_jwt = false` for this one function; secret in `HELPSCOUT_WEBHOOK_SECRET`.

## Nice consequence

proof-viewer's own "Send a reminder" fires `agent.reply.created` too, so it now
auto-suppresses via this webhook — making the manual "snooze after sending"
checkbox largely redundant (candidate for simplification later).

## Rollout

1. Push migration (`pnpm db:push:confirm`) + deploy function
   (`supabase functions deploy helpscout-webhook`).
2. Set `HELPSCOUT_WEBHOOK_SECRET`.
3. Create the webhook in Help Scout; use "Send test" to confirm 200 + a column
   update.
4. End-to-end: reply on a test conversation linked to a test proof, confirm the
   timestamp updates and the flag drops; let the window lapse, confirm it returns.

## Deferred

- Tag sync (`convo.tags` → `helpscout_tags`) to light up `helpscout_follow_up_tag`.
- Admin card for the grace-days setting.
- Surfacing customer replies as their own positive signal (vs just suppressing).
