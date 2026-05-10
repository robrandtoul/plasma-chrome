# Variant-round selection sweep — 2026-05-10

Row 28 from the candidate list at the end of the 2026-05-10 functional sweep. Goal: exercise the `proof-action` edge function's variant-round selection path end-to-end — from customer HTTP POST through DB writes through HS thread creation — and verify the lock-on-selection contract is enforced server-side.

This sweep covers both the bug discovery (pre-fix) and fix verification (post-fix after deploying commit `d7af217`).

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 28 (pre-fix)  | **fail** | Second POST with different variant returned `{status:'ok'}` — lock-on-selection not enforced |
| 28 (post-fix) | **pass** | Lock holds: first selection succeeds, subsequent attempts return 400 with zero DB/HS noise |

Finding: `PV-2026W19-014` — proof-action edge function does not enforce variant-round lock-on-selection server-side.

## Fixture

Reused from Row 28 pre-fix run (created earlier this session). Tagged `[QA-fn]` in `internal_notes`, linked to HS conversation `3307718805`.

| Proof ID | Version ID | Purpose |
|----------|------------|---------|
| `a5206f7e-6a2f-493b-b10f-b4f6b527fee2` | `b4f381d5-30ef-4d3f-bce0-f5dbbf440746` | Row 28 — variant-round selection |

Version: `is_variant_round=true`, `names=[]`, metal_steel, GBP. Two variants:
- Charcoal: `b069c9cb-fdb7-4295-ad93-cf134eb9b25a`
- Silver: `8c83dfe7-c117-4088-9af1-25a823008a98`

## Bug: Row 28 pre-fix

**Action:** Two sequential POSTs to the deployed edge function (at commit `1924143`, before fix):

POST 1 — choose Charcoal:
```json
{
  "proof_version_id": "b4f381d5-30ef-4d3f-bce0-f5dbbf440746",
  "event_type": "request_changes",
  "actor_name": "Johnny Appleseed",
  "name": "__shared__",
  "comment": "The Charcoal variant feels more refined.",
  "material_option_code": null,
  "round_variant_id": "b069c9cb-fdb7-4295-ad93-cf134eb9b25a"
}
```

POST 2 — attempt Silver on same locked version:
```json
{
  "proof_version_id": "b4f381d5-30ef-4d3f-bce0-f5dbbf440746",
  "event_type": "request_changes",
  "actor_name": "Johnny Appleseed",
  "name": "__shared__",
  "comment": "Actually I prefer Silver.",
  "material_option_code": null,
  "round_variant_id": "8c83dfe7-c117-4088-9af1-25a823008a98"
}
```

**Expected:** POST 2 returns 400 `{status:'failed', reason:'validation', detail:'this variant round has already been locked by a customer selection'}`.

**Observed:** Both POSTs returned `{status:'ok'}`. POST 2 also posted HS threads ("Johnny Appleseed chose: Silver.") and overwrote the `proof_name_approvals` row with Silver's data. A third POST with a different comment also returned `{status:'ok'}`.

**DB state after bug run:**
- `proof_events`: two rows (one per POST), both with `{status:'ok'}` event IDs
- `proof_name_approvals`: one row with `name='__shared__'`, `change_request='Actually I prefer Silver.'` — second POST's data overwrote first

**HS footprint of bug (conversation 3307718805):**
- Threads 10117847568 / 10117847574 (09:28:41): Charcoal selection — legitimate first selection
- Threads 10117847603 / 10117847607 (09:28:43): Silver selection — spurious second "selection" that should have been blocked
- Threads 10117858174 / 10117858177 (09:37:59): Third attempt — also went through unchecked

### Root cause

The pre-fix edge function (commit `1924143`) had no lock-on-selection enforcement at all. The `proof_name_approvals` upsert used a standard merge-on-conflict with `{ onConflict: 'proof_version_id,name' }`, which silently overwrote any existing row. There was no pre-check SELECT and no `ignoreDuplicates: true` fallback.

The fix (commit `d7af217`) adds two enforcement layers:
1. **Pre-check SELECT** — before writing anything, queries `proof_name_approvals` for `(proof_version_id, '__shared__')`. If a row exists, returns 400 immediately. This keeps `proof_events` clean — a rejected attempt generates no DB trace.
2. **`ignoreDuplicates: true` on the upsert** — for the race window between the pre-check and the upsert (two simultaneous requests), the upsert uses `ON CONFLICT DO NOTHING`. If `insertedApproval.length === 0`, the second request also returns 400.

Standard (non-variant-round) upserts are unchanged — customers can update a request_changes comment or switch from request_changes to approve on normal proofs.

## Fix verification: Row 28 post-fix

The fix was deployed via `supabase functions deploy proof-action --project-ref xpcjanqrcgzjmwketxtt`. The `proof_name_approvals` lock row was deleted to reset the fixture, then a clean three-POST sequence was run.

**POST 1 — choose Charcoal (should succeed):**

```json
{
  "proof_version_id": "b4f381d5-30ef-4d3f-bce0-f5dbbf440746",
  "event_type": "request_changes",
  "actor_name": "Johnny Appleseed",
  "name": "__shared__",
  "comment": "The Charcoal variant feels more refined.",
  "round_variant_id": "b069c9cb-fdb7-4295-ad93-cf134eb9b25a"
}
```

**Observed:** `{status:'ok', event_id:'8d2f6933-5da2-4495-9592-3ef43e38db96'}` ✅

**POST 2 — attempt Silver (should be blocked):**
**Observed:** HTTP 400, `{status:'failed', reason:'validation', detail:'this variant round has already been locked by a customer selection'}` ✅

**POST 3 — attempt Charcoal again (should be blocked):**
**Observed:** HTTP 400, same detail ✅

### DB state after fix verification

`proof_name_approvals`:
```json
{
  "id": "860f6c26-a900-427d-9f47-0e46f52f8477",
  "name": "__shared__",
  "state": "changes_requested",
  "change_request": "The Charcoal variant feels more refined.",
  "actor_name": "Johnny Appleseed",
  "created_at": "2026-05-10T09:42:58.462791+00:00",
  "updated_at": "2026-05-10T09:42:58.443+00:00"
}
```

Lock row contains Charcoal's data only — not overwritten. ✅

`proof_events` (since reset): one row only — `8d2f6933`, Charcoal, `round_variant_id='b069c9cb'`. Zero events for the two blocked attempts. ✅

### HS threads verified (conversation 3307718805)

POST 1's selection landed correctly:
- Thread 10117863947 (type `customer`, 09:42:59): `"Johnny Appleseed chose: Charcoal.<br><br>\"The Charcoal variant feels more refined.\"<br><br>View the proof: https://proofs.plasmadesign.co.uk/p/a5206f7e-...<br>— Posted via the proof viewer"` ✅
- Thread 10117863956 (type `message`, sender Rob Randtoul id 52245, 09:43:00): `"Thanks, we've recorded your selection for version 1: Charcoal.<br><br>The Charcoal variant feels more refined.<br><br>We'll incorporate this and get an updated proof over to you shortly."` ✅

POST 2 and POST 3 (blocked): zero HS threads created. The pre-check fires before the HS write path, so rejected attempts leave no trace in the conversation. ✅

### Template rendering

The confirmation reply used the `proof_variant_selection_confirmation` template (seeded in migration 000157). The `{chosen_variant}` placeholder rendered as `"Charcoal"` (from `proof_round_variants.display_name`). The `{change_notes}` block rendered the customer's comment inline. Both conditional blocks correct. ✅

Sender resolution: tier-1 path (proof's `created_by` → `profiles.helpscout_user_id = 52245` → Rob Randtoul). Same path confirmed in the HS reply posting sweep. ✅

## Impact of bug in production

In production, a customer who "changed their mind" after submitting a variant selection would have generated two sets of HS threads — a legitimate "chose: Charcoal" pair and a second "chose: Silver" pair — with the `proof_name_approvals` row silently overwritten to record Silver. The designer would receive both confirmation replies and have no reliable record of which variant the customer actually settled on. The UI's lock-on-selection (CTA hidden on locked rounds) would have been purely a client-side courtesy, bypassable via stale tab, direct POST, or page refresh.

## What this sweep did not cover

- **Concurrent selection race (two simultaneous POSTs):** The `ignoreDuplicates: true` belt-and-braces path (the `length === 0` check) was not exercised — that requires near-simultaneous concurrent requests. It is correct by construction given PostgREST's `ON CONFLICT DO NOTHING` behaviour under the unique index.
- **Named-recipient + option-suffix HS copy:** All fixtures used the all-shared path.
- **Variant rounds with per-direction-pricing (rows 20, 21):** Needs browser (Chrome MCP).

## Open candidate slices for next time

- **Named-recipient + option-suffix HS copy:** Exercise `recipientSuffix + optionSuffix` branches with `names=["Alice"]` and non-base `material_option_code`.
- **Variant rounds with per-direction-pricing (rows 20, 21):** Customer page docket-hide; needs browser.
- **Designer flow on the new-proof form (rows 33–38):** URL-paste, multi-match picker, override-reason; needs browser.
- **Per-option-tab image filtering (row 42):** Needs browser.
