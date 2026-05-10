# HS reply posting sweep — 2026-05-10

Slice chosen from the candidate list at the end of the 2026-05-10 functional sweep. Goal: exercise the `proof-action` edge function end-to-end — from customer HTTP POST through DB writes through Help Scout thread creation and confirmation reply — for the two primary customer actions (approve, request_changes). The DB-only sweep verified the state-machine layer; this sweep covers the HTTP and HS API layers that were explicitly flagged as untested.

Rows exercised: 24 (approve → status flip), 27 (request_changes), and a 24a sub-fixture to isolate the auto-finalize trigger from the HS round-trip.

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 24  | pass   | Approve: edge function round-trip clean, both HS threads (customer + staff reply) landed correctly |
| 24a | pass   | Approve + auto-finalize: status flipped to `approved` via `_finalize_proof_if_complete` trigger |
| 27  | pass   | Request changes: comment propagated end-to-end, confirmation reply embeds change_notes correctly |

Zero new bugs. All six HS threads verified against the live conversation history.

## Methodology

All requests made via `curl` from the bash sandbox against the deployed Supabase edge function (`https://xpcjanqrcgzjmwketxtt.supabase.co/functions/v1/proof-action`). Fixtures created via service-role REST. HS thread content verified directly against the live conversation (3307718805 / number 422593) using `mcp__helpscout__getThreads`.

`Origin: https://proofs.plasmadesign.co.uk` header included on all curl calls so the edge function builds a prod-pointing `/p/{proof_id}` URL in the customer thread body (rather than falling back to empty string).

## Fixtures created this run

All tagged `[QA-fn]` in `internal_notes`, linked to HS conversation `3307718805`.

| Proof ID | Version ID | Purpose |
|----------|------------|---------|
| `e8064279-81af-4127-933e-86e6a86d579b` | `f966b218-8089-44b7-b11c-a6a5296280cc` | Row 24 — approve, no images (tests HS round-trip only) |
| `79c66f5e-53e3-4964-a1d3-f58333b5247e` | `50e0c56d-85a4-4cc1-8fc1-b3dbf028aeb3` | Row 27 — request_changes |
| `225644c5-9a1f-4cf2-96ad-6deceaabb5b1` | `5920ec87-f007-4d9e-9cfa-f5f4120d7cee` | Row 24a — approve with shared image, tests auto-finalize flip |

All are metal_steel / 800um / GBP, single-version, no names (all-shared path), `is_variant_round = false`.

Row 24a has one `proof_version_images` row (`associated_name = null`, `side = 'front'`, `original_filename = '[QA] dummy-front.jpg'`) to satisfy the `v_required_slots > 0` condition in `_finalize_proof_if_complete`.

## Row 24 — approve, all-shared proof (no images)

**Setup:** Fresh proof + v1 linked to HS conv 3307718805. `names = []`, no images, `material_options = ['natural','brushed','mirror']`. No prior `proof_name_approvals`.

**Action:** POST to edge function:
```json
{
  "proof_version_id": "f966b218-8089-44b7-b11c-a6a5296280cc",
  "event_type": "approve",
  "actor_name": "Johnny Appleseed",
  "name": "__shared__",
  "material_option_code": null,
  "round_variant_id": null
}
```

**Expected:** `{status: 'ok'}`, proof_events row created, proof_name_approvals row with `state='approved'`, HS customer thread posted, HS confirmation reply posted as Rob Randtoul.

**Observed:** All expected. Detailed:

- Edge function: `{status: 'ok', event_id: 'fcabbb69-f7a6-4207-adc9-bfb82734fa6c'}`
- `proof_events`: event_type `approve`, actor_name `Johnny Appleseed`, name `__shared__`, comment `null`, `helpscout_thread_id = '10117833818'`
- `proof_name_approvals`: `state = 'approved'`, `change_request = null`, `actor_name = 'Johnny Appleseed'`, `actor_ip` stamped
- HS thread 10117833818 (type `customer`): `"Approved by Johnny Appleseed.<br><br>Approved version: (no files)<br>View the proof: https://proofs.plasmadesign.co.uk/p/e8064279-...<br>— Posted via the proof viewer"`
- HS thread 10117833823 (type `message`, sender Rob Randtoul id 52245): `"Thanks for approving version 1. We'll be in touch shortly about next steps."`
- **Proof status: `in_progress`** — did NOT flip. See note below.

**Status-flip note (not a bug):** The `_finalize_proof_if_complete` helper (migration 000128) computes `v_required_slots = v_names_count + (1 if has_shared AND names_count = 0 else 0)`. With `names = []` and no images, `v_has_shared = false`, so `v_required_slots = 0`. The helper returns early on `v_required_slots = 0`. This is correct — there is no completable slot set on an image-free proof. Row 24a isolates the auto-finalize path with a proper shared-image fixture.

**Pass.**

## Row 24a — approve + auto-finalize (with shared image)

**Setup:** Fresh proof + v1, same material/currency/HS conv as Row 24, but with one `proof_version_images` row (`associated_name = null` = shared, `original_filename = '[QA] dummy-front.jpg'`). This gives `v_has_shared = true` and `v_required_slots = 1`.

**Action:** Same POST shape as Row 24 against the new version id.

**Expected:** Edge function returns `{status: 'ok'}`, proof status flips to `approved`, `approved_at` set.

**Observed:**

- Edge function: `{status: 'ok', event_id: '55771281-4526-4730-b3ae-0add84649fcc'}`
- `proof_name_approvals`: `state = 'approved'`
- **Proof status: `approved`**, `approved_at: 2026-05-10T09:18:16Z` — trigger fired correctly
- HS thread 10117836213 (type `customer`): `"Approved by Johnny Appleseed.<br><br>Approved version: [QA] dummy-front.jpg<br>View the proof: https://proofs.plasmadesign.co.uk/p/225644c5-...<br>— Posted via the proof viewer"` — filename from `proof_version_images.original_filename` ✅
- HS thread 10117836220 (type `message`, sender Rob Randtoul): `"Thanks for approving version 1. We'll be in touch shortly about next steps."` ✅

**Pass.** `_finalize_proof_if_complete` trigger intact post-000158.

## Row 27 — request_changes

**Setup:** Separate fresh proof + v1, same material/HS conv, no images, no names.

**Action:** POST to edge function:
```json
{
  "proof_version_id": "50e0c56d-85a4-4cc1-8fc1-b3dbf028aeb3",
  "event_type": "request_changes",
  "actor_name": "Johnny Appleseed",
  "name": "__shared__",
  "comment": "Please adjust the font weight — it looks too light in the preview.",
  "material_option_code": null,
  "round_variant_id": null
}
```

**Expected:** `{status: 'ok'}`, proof_events row with comment, proof_name_approvals with `state='changes_requested'` and `change_request` populated, HS threads posted, status stays `in_progress`.

**Observed:**

- Edge function: `{status: 'ok', event_id: 'b1dc274f-221d-42dc-9f36-a1427dcab962'}`
- `proof_events`: event_type `request_changes`, comment `"Please adjust the font weight — it looks too light in the preview."`, `helpscout_thread_id = '10117833851'`
- `proof_name_approvals`: `state = 'changes_requested'`, `change_request = "Please adjust the font weight — it looks too light in the preview."`, `actor_name = 'Johnny Appleseed'`
- **Proof status: `in_progress`** — correct, request_changes never triggers auto-finalize
- HS thread 10117833851 (type `customer`): `"Changes requested by Johnny Appleseed.<br><br>\"Please adjust the font weight — it looks too light in the preview.\"<br><br>Version: (no files)<br>View the proof: https://proofs.plasmadesign.co.uk/p/79c66f5e-...<br>— Posted via the proof viewer"`
- HS thread 10117833857 (type `message`, sender Rob Randtoul): `"Thanks, we've recorded your changes for version 1:<br><br>Please adjust the font weight — it looks too light in the preview.<br><br>We'll get an updated proof over to you shortly."` — the `{? change_notes}` conditional block rendered correctly with the comment embedded ✅

**Pass.**

## Sender resolution observed

All three confirmation replies were sent by Rob Randtoul (HS user id 52245). The proof fixtures set `created_by` to Rob's profile id (`59205cfa-...`), and the profiles table has `helpscout_user_id = 52245` for that row. Tier-1 sender resolution (proof's designer → profiles.helpscout_user_id) is working correctly. Tier-2 (conversation assignee) and tier-3 (skip + warn) were not exercised as the tier-1 path succeeded for all three.

## Cosmetic observation (not a bug)

Image-free fixture proofs produce `"Approved version: (no files)"` in the customer thread. This is the documented empty-list fallback in `buildCustomerThreadText` (`fileLine = fileNames.length > 0 ? ... : '(no files)'`). In real use, no designer sends an empty proof to a customer, so this string would not appear. No action needed.

## What this sweep did not cover

- **Row 28 (variant selection):** Rows 24/27/24a were sufficient for one session. Row 28 shares the HS layer with these rows but adds the `round_variant_id` path and variant-lock contract. Worth a dedicated fixture in the next sweep.
- **Named-recipient thread text:** All fixtures used the all-shared path (`name = '__shared__'`). The `recipientSuffix = " for {name}"` branch was not exercised here; it appeared correctly in earlier manual tests visible in the HS thread history (`"Approved by Rob for Rob for the Natural finish."`).
- **Option-suffix rendering:** `material_option_code` was null on all requests. The `optionSuffix` branch (e.g., `" for the Brushed finish"`) was not exercised in this sweep.
- **Tier-2 / tier-3 sender resolution:** Not exercised; tier-1 succeeded for all three.
- **HS 404 / auth failure partial path:** Not exercised; HS was healthy throughout.

## Open candidate slices for next time

Continuing from the 2026-05-10 functional sweep's candidate list, minus what this sweep covered:

- **Row 28 (variant selection end-to-end):** curl POST with `round_variant_id`, verify lock-on-selection in HS thread + confirmation reply body.
- **Named-recipient + option-suffix HS copy:** Exercise the `recipientSuffix + optionSuffix` branches with a fixture that has `names = ["Alice"]` and a non-base `material_option_code`.
- **Variant rounds with per-direction-pricing (rows 20, 21):** Customer page docket-hide; needs browser (Chrome MCP).
- **Designer flow on the new-proof form (rows 33–38):** URL-paste, multi-match picker, override-reason; needs browser.
- **Per-option-tab image filtering (row 42):** Needs browser.
