# Help Scout merge → proof re-point (webhook)

Status: **v1 shipped + tested; the convo.merged payload turned out NOT to embed
the merge threads, so v2 fetches them from the Help Scout API. Awaiting a final
confirmation test merge after the v2 deploy.**

## Why

A proof stores the id of its linked Help Scout conversation in
`proofs.helpscout_conversation_id`. When a designer **merges** that conversation
into another one in Help Scout, Help Scout **deletes the source conversation**
and moves its threads into the surviving target. The proof keeps the old, now
dead id — so every later "fetch the conversation" step (the **Send a reminder**
button, the **Conversation context** panel, any reply send) gets a **404** and
the cryptic message *"Help Scout conversation not found"*.

This happened live: proof `f3dda115-…` was linked to conversation `3345551238`,
which Chris merged into `3345553414` on 2026-06-11. The link was fixed by hand;
this feature stops it recurring.

A one-off sweep of all 44 linked proofs (2026-06-11) found that proof was the
**only** orphan — every other link was live. So there is no backlog to repair;
this is purely prevention.

## What it does

The existing inbound `helpscout-webhook` gains one event: **`convo.merged`**.
When a merge arrives, the handler re-points every proof linked to the deleted
source conversation onto the surviving target — id **and** url — and records an
`audit_log` row per proof. Self-healing: proofs fix themselves the instant a
merge happens, before anyone clicks anything.

No database migration. It reuses the two `helpscout_*` columns that already
exist; the only new artefact is the `proof.helpscout_link_remapped` audit action.

## How the source/target is resolved

Help Scout records a merge on the **surviving (target)** conversation: each
thread moved in from the deleted source keeps a `merged` line-item whose
`action.associatedEntities.originalConversation` names that source id. The
handler:

1. Treats the webhook's conversation (`payload.id`) as the **target**.
2. **Fetches the target's thread trail from the Help Scout API**
   (`GET /v2/conversations/{id}/threads`, OAuth via the shared `getAccessToken`),
   and collects every `action.type === "merged"` → `originalConversation` value
   (deduped — one merge moves several threads, all naming the same source).
   Threads come newest-first, so a fresh merge's line-items are on page 1; no
   pagination. A cheap payload-embedded check runs first in case Help Scout ever
   starts embedding the line-items, but today it never matches.
3. For each source id: `update proofs set helpscout_conversation_id = <target>,
   helpscout_conversation_url = …/<target> where helpscout_conversation_id =
   <source>` and audits each changed row.

Matching on the conversation column (not proof id) moves every proof sharing a
dead id together. The whole thing is **idempotent**: a re-point only fires for
source ids that still match a proof, so a redelivered event — or old merge
line-items still in the thread list — is a harmless no-op.

## Why fetch instead of reading the payload (what the test merges showed)

v1 read the source ids off `payload._embedded.threads`, on the assumption (the
docs don't specify) that the `convo.merged` payload embeds the merge line-items
the way reply-event payloads embed threads. Three live test merges on
2026-06-11 disproved it: the webhook fired (v9, HTTP 200) and the handler ran,
but **no re-point happened** because the payload carried no merge line-items.
The merge metadata lives on the surviving conversation in Help Scout, but is not
in the webhook body. So v2 stops trusting the payload and fetches the
authoritative thread trail from the API.

This still assumes the event fires for the **surviving target** (so its
`payload.id` is fetchable). That held in every observed merge. If a future event
ever represents the deleted source instead, the API fetch 404s and the
diagnostic row (below) captures `api_status` so it's obvious.

## Diagnostics (because edge-function console logs aren't queryable)

The Supabase MCP exposes only request-level edge logs, not `console.log` output,
so the handler routes its diagnostics to `audit_log` where they can be read by
SQL:

- On the **no-op path** (a merge that re-pointed nothing) it writes one
  `helpscout.merge_no_repoint` row with `{ embedded_source_ids, api_status,
  api_thread_count, source_ids, payload_top_keys }`.
- For an **unexpected event type** (not a merge, reply, or created/moved trigger
  — e.g. a differently-named merge event) it writes one
  `helpscout.webhook_unhandled_event` row with the event header.

Both are temporary diagnostic actions; remove them once merge sync is proven in
production. The success path writes only the clean
`proof.helpscout_link_remapped` rows.

## Rollout

1. Deploy the function:
   `supabase functions deploy helpscout-webhook --project-ref bjvinrzbdrwebylkmbwy`
   (Homebrew `supabase`, per memory:feedback_proof_viewer_edge_deploy).
2. In Help Scout, on the existing proofs webhook, **tick the `convo.merged`
   event** (done in v1 rollout). No new secret — same signature +
   `PROOFS_HELPSCOUT_WEBHOOK_SECRET`. v2 additionally calls the Help Scout API,
   so `HELPSCOUT_APP_ID` / `HELPSCOUT_APP_SECRET` must be set as function secrets
   (already present — the reply senders use them; secrets are project-wide).
3. Confirmation test merge: link a test proof to a throwaway conversation, merge
   that conversation into another (same customer — Help Scout only merges within
   one email), confirm the proof re-points and a `proof.helpscout_link_remapped`
   audit row appears. If it doesn't, read the `helpscout.merge_no_repoint` /
   `helpscout.webhook_unhandled_event` diagnostic row to see why.
4. Once proven, remove the two diagnostic audit actions.

## Security

Unchanged from the reply path: HMAC-SHA1 signature verified before any work;
service-role writes scoped to the two `helpscout_*` columns on matched proofs;
empty/structured 200s, no data leak. v2 adds an outbound OAuth call to the Help
Scout API (read-only `GET …/threads`) using the existing app credentials.

## Deferred (Layer 2, not built)

A reactive safety net for any orphan the webhook misses (a merge from before
this shipped, or a dropped delivery): on a 404 in `send-helpscout-reply` (and the
Conversation-context fetch), run the same deterministic source-id lookup against
the customer's live conversations, re-point, and retry — and if it genuinely
can't, show *"this conversation was merged or deleted — re-link it"* instead of
*"Help Scout conversation not found"*. Decided against for now; revisit if
orphans recur despite Layer 1.
