# Help Scout merge → proof re-point (webhook)

Status: **built, awaiting deploy + Help Scout config + a confirmation test merge.**

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
2. Walks `payload._embedded.threads`, collecting every
   `action.type === "merged"` → `originalConversation` value (deduped — one
   merge moves several threads, all naming the same source).
3. For each source id: `update proofs set helpscout_conversation_id = <target>,
   helpscout_conversation_url = …/<target> where helpscout_conversation_id =
   <source>` and audits each changed row.

Matching on the conversation column (not proof id) moves every proof sharing a
dead id together. The whole thing is **idempotent**: a re-point only fires for
source ids that still match a proof, so a redelivered event — or old merge
line-items still in the thread list — is a harmless no-op.

## The one unknown — confirm with a test merge

Help Scout's public webhook docs list `convo.merged` but **do not specify the
payload shape** — whether it fires for the surviving target (carrying the merge
line-items, as the design above assumes) or for the deleted source, and whether
`_embedded.threads` is included. The live data we already have shows the merge
metadata lives on the target, and this account's webhook payloads already embed
threads (the reply handler reads them), so the target-payload assumption is the
likely one — but it is unconfirmed.

The handler is **safe under uncertainty**: if the payload carries no merge
line-items, it logs the shape (`targetId`, whether threads were embedded, thread
count) and acks with `repointed: 0` — no guessing. So the rollout step is:

> After deploy, merge two throwaway Help Scout conversations and read the
> delivered `convo.merged` payload from the function log. Confirm `payload.id`
> is the surviving conversation and the merged line-items are present. If
> instead it represents the **source**, add a follow-up that looks up the
> target (via the customer's conversations) before re-pointing.

Same "confirm against a real event" caution as `docs/helpscout-webhook-spec.md`.

## Rollout

1. Deploy the function:
   `supabase functions deploy helpscout-webhook --project-ref bjvinrzbdrwebylkmbwy`
   (Homebrew `supabase`, per memory:feedback_proof_viewer_edge_deploy).
2. In Help Scout, on the existing proofs webhook, **tick the `convo.merged`
   event**. (No new secret — same signature + `PROOFS_HELPSCOUT_WEBHOOK_SECRET`.)
3. Test merge two throwaway conversations; confirm the log shows the expected
   payload shape and, if a test proof was linked to the source, that it
   re-pointed (and a `proof.helpscout_link_remapped` audit row exists).

## Security

Unchanged from the reply path: HMAC-SHA1 signature verified before any work;
service-role writes scoped to the two `helpscout_*` columns on matched proofs;
empty/structured 200s, no data leak.

## Deferred (Layer 2, not built)

A reactive safety net for any orphan the webhook misses (a merge from before
this shipped, or a dropped delivery): on a 404 in `send-helpscout-reply` (and the
Conversation-context fetch), run the same deterministic source-id lookup against
the customer's live conversations, re-point, and retry — and if it genuinely
can't, show *"this conversation was merged or deleted — re-link it"* instead of
*"Help Scout conversation not found"*. Decided against for now; revisit if
orphans recur despite Layer 1.
