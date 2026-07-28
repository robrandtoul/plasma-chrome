# Stock Control-side changes for Phase 3 of the order hand-off

**Status: authored and syntax-checked, NOT yet deployed.** Written 2026-07-27.

Phase 3 frees the wording of the workshop note and the supplier email
(`docs/order-handoff-spec.md` §6). That is only safe once Stock Control's webhook parsers stop
depending on those messages being parseable. This file holds the exact changes, because Stock
Control lives in a **separate repo** that proof-viewer can't edit.

⚠ **Port these into the Stock Control repo before (or immediately after) deploying them.** A
function deployed from outside its own repo is silently reverted by that repo's next deploy — the
documented footgun in memory:edge-fn-branch-deploy-reverts. Deploying from here alone leaves
production diverged from source with nothing to warn you.

Rob's decision (2026-07-27): **gate the parsers, don't unsubscribe the webhooks.**

## Why gating rather than unsubscribing

The gate is *"stay silent only if a job already exists for this order"*. That is self-limiting in
exactly the right direction:

- direct write succeeded → a job exists → the parser stays quiet (no duplicate, no correction-note
  spam);
- direct write **failed** → no job exists → the gate doesn't apply → the old import path runs
  exactly as it does today.

So the backstop survives precisely when it is needed. Unsubscribing would remove it permanently.
Reverting the gate is a one-condition change.

## 1. `helpscout-inhouse-order` — gate + keep artwork working

Three edits, all in the deployed v44 source. Combined they do two jobs at once: they gate the
parser for directly-written jobs, **and** they fix the artwork dependency that otherwise blocks
Phase 3b.

### Why artwork is the blocker

Files reach a Stock Control job card only because this function mirrors the note's attachments.
That mirror is gated twice: `syncArtworkBestEffort` returns early without an `orderId`, and
`processConversation` returns `no_order_note` (with no order id) before it ever reads the subject.
`pickDefaultThread` is gated the same way, so the admin **"sync attachments" recovery sweep breaks
identically** — the one tool you would reach for when artwork "didn't come through".

Measured on live 2026-07-27: **126 in-house jobs in 90 days, 85 carrying artwork, 0 job cards
carrying an artwork link.** Freeing the in-house wording without this change would blank artwork on
roughly two thirds of job cards, with the recovery tool silently returning "synced 0".

(Migration `000360` separately puts `Artwork: <dropbox url>` on the job card, so the floor is now
"click the link" rather than nothing. This change restores the files themselves.)

### Edit 1 — `pickDefaultThread`: fall back to any staff thread carrying files

```diff
     if ((t._embedded?.attachments ?? []).length > 0) return t
     if (!firstOrder) firstOrder = t
   }
-  return firstOrder
+  if (firstOrder) return firstOrder
+  // No order-shaped thread at all. Since proof-viewer began writing jobs
+  // directly, the hand-off note's wording is editable and may legitimately no
+  // longer parse — but its files must still reach the job card, and this
+  // function also backs the admin "sync attachments" recovery sweep. Fall back
+  // to the NEWEST staff thread that actually carries files.
+  const withFiles = staffThreadsOldestFirst(convo).filter(
+    (t) => (t._embedded?.attachments ?? []).length > 0,
+  )
+  return withFiles.length ? withFiles[withFiles.length - 1] : null
 }
```

Newest-first is deliberate: on a customer conversation carrying proofing history, the order note is
the newest staff thread with attachments, so this picks it.

### Edit 2 — resolve the subject and any existing job BEFORE requiring a parseable note

This is both the gate and the artwork fix. Insert immediately after the `no_staff_thread` guard in
`processConversation`, and delete the old `const { orderNo, customer } = parseSubject(...)` line
that currently sits after the `findOrderNote` check:

```ts
  const { orderNo, customer } = parseSubject(convo.subject ?? '')
  if (orderNo) {
    const preExisting = await client
      .from('orders')
      .select('id, import_source')
      .eq('inhouse_order_no', orderNo.trim())
      .neq('status', 'cancelled')
      .maybeSingle()
    if (preExisting.data) {
      return {
        status: preExisting.data.import_source === 'direct' ? 'direct_handoff' : 'already_imported',
        orderId: preExisting.data.id,
      }
    }
  }
```

Returning the order id is what keeps `syncArtworkBestEffort` running for a job whose note no longer
parses.

### Edit 3 — drop the now-redundant duplicate lookup

The original `// Idempotency: already imported under this number` block (after the `orderNo` guard)
is superseded by Edit 2 and must be removed, or the same query runs twice.

### Behaviour delta

| Situation | Before | After |
| --- | --- | --- |
| Note parses, no job yet | imports | unchanged |
| Note parses, job exists | `already_imported`, artwork syncs | same (or `direct_handoff`) |
| **Note doesn't parse, job exists** | `no_order_note`, **no artwork** | job resolved, **artwork syncs** |
| Note doesn't parse, no job | `no_order_note` | unchanged |
| Direct write failed, note parses | imports (backstop) | **unchanged — backstop intact** |

## 2. `helpscout-outsourced-order` — gate the inserts AND the correction notes

Not yet authored. Required before the **supplier** wording is freed, for two reasons found in
review:

1. **Correction-note spam.** Unlike the in-house function this one has **no `postOnce` /
   `noteAlreadyPosted` dedupe** and is subscribed to `convo.thread.created` as well as
   `convo.created`. A reworded email that half-parses would post a fresh
   `PlasmaDesign stock-control: couldn't import…` note on **every later supplier reply, forever**.
2. **A duplicate supplier job.** Its adoption key is trimmed ref + supplier + **quantity**, where
   quantity is read off the `Qty:` line and is qty **plus spoilage overs**. Any wording that prints
   a different number (prose like "500 cards plus 10 spares", or a template using a
   customer-quantity variable) misses adoption and **INSERTs a second job**.

The gate: before any insert or `postNote`, return quietly if a non-cancelled
`outsourced_orders` row with `import_source = 'direct'` exists for this ref + supplier.

Mitigation already shipped: `place-order` now stamps `outsourced_orders.helpscout_conversation_id`
itself right after creating the supplier conversation, so the parser's *first* dedupe check matches
regardless of wording. That covers the common path but is not a substitute for the gate — it
depends on the stamp landing before the webhook fires.

## 3. Housekeeping

`place-inhouse-order` is still ACTIVE (v7) and orphaned — superseded by `place-order`. Delete or
disable it.
