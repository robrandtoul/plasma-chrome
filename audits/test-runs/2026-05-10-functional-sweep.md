# Functional sweep — 2026-05-10

State-machine focused slice from the test matrix playbook. Goal: find new bugs in the same class as 000158 (reopen carry-forward) — workflow / trigger / state-transition bugs that materially affect designer or customer experience but aren't obvious in code review.

Six rows walked at the DB and RPC layer. No browser. Service-role key for fixture setup and verification.

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 25 | pass | Per-recipient partial approval keeps status `in_progress` |
| 26 | pass | Per-recipient full approval flips status via `maybe_finalize_proof_status` trigger |
| 28 | pass | Variant-round lock-on-selection enforced by unique constraint on `proof_name_approvals(proof_version_id, name)` |
| 30 | pass | `bump_proof_activity` flips dormant → in_progress on version touch; case statement preserves other statuses |
| 53 | pass | `stuck_in_progress` rule fires correctly when `last_activity_at` exceeds threshold (10 business days) |
| 60 | pass | Reply template `DEFAULT_BODIES` in code match seeded bodies in DB across all 5 templates |

Zero new findings. Sweep was clean.

## Fixtures

Three new test proofs created during this run, all tagged `[QA-fn]` in `internal_notes` and linked to HS conversation `3307718805`:

- `d57657d8-185e-4d14-8639-34bab161ae1e` — Rows 25/26, two-name split (Alice/Bob), now in `approved` state
- `7ecfb4cb-ee79-4612-8849-88a76c307625` — Row 53, single-name, forced `last_activity_at = 2026-04-20`
- (Row 30 used `f34f0fdc` from yesterday's Row 6; trigger flipped it from forced-dormant back to `in_progress` with fresh `last_activity_at`)

## Row 25 — per-recipient partial approve

**Setup:** Fresh proof + v1 with `names = ["Alice", "Bob"]`, no images, no existing approvals.

**Action:** `INSERT INTO proof_name_approvals (proof_version_id, name, state, actor_name) VALUES (..., 'Alice', 'approved', 'Alice (test)')`.

**Expected:** `proofs.status` stays `in_progress`, `approved_at` stays null. The `maybe_finalize_proof_status` trigger should not fire its action because Bob's slot is still unapproved.

**Observed:** Match. Status `in_progress`, `approved_at: null`. Pass.

## Row 26 — per-recipient full approve

**Setup:** Continuation of row 25 (Alice's approval row already in place).

**Action:** Insert Bob's approval row with the same shape.

**Expected:** All required slots (Alice, Bob, no `__shared__` because no shared images) are now state=`approved`. Trigger fires its action: `proofs.status = 'approved'`, `approved_at = now()`.

**Observed:** Match. Status flipped to `approved`, `approved_at = 2026-05-10T08:50:19.589Z` (matches the second insert's `created_at` to the millisecond, confirming trigger fired in the same statement).

Pass. The `maybe_finalize_proof_status` trigger from migration 000126 is intact post-000158.

## Row 28 — variant-round lock-on-selection

**Approach:** Two-layer verification.

1. **DB-level lock:** `proof_name_approvals_proof_version_id_name_key` unique constraint on `(proof_version_id, name)`. Verified by attempting a duplicate INSERT for `(version_id, 'Alice')`: returns `23505 duplicate key value violates unique constraint`. The constraint is the load-bearing piece — concurrent variant-round selections serialise on this index.

2. **Edge-function pre-check:** Read `supabase/functions/proof-action/index.ts` lines 649–681. The variant-round branch SELECTs `proof_name_approvals` by `(proof_version_id, '__shared__')` before attempting the upsert; if a row exists, returns 400 "this variant round has already been locked by a customer selection". Belt-and-braces against the race window between SELECT and UPSERT relies on the unique index from layer 1.

Pass. The contract from CustomerProofPage line 1453 ("no in-page change-of-mind; reply by email") is enforced at both layers.

## Row 30 — dormant view bump

**Setup:** Took fixture `f34f0fdc` (yesterday's Row 6, status `in_progress`). Force-updated to `status = 'dormant'`, `last_activity_at = '2026-04-01'`.

**Action:** PATCH on the current `proof_versions` row (just touched `shipping_note` to fire the `proof_versions_bump_activity` trigger).

**Expected:** `bump_proof_activity` trigger updates `proofs.last_activity_at = now()` and runs `status = case when status = 'dormant' then 'in_progress' else status end`. Status flips to `in_progress`.

**Observed:** Match. Status flipped to `in_progress`, `last_activity_at` updated to `2026-05-10T08:52:43.193Z`.

Pass. The trigger directionality from migration 000018 is intact.

**Not exercised:** the negative direction (`approved` and `abandoned` should stay put). The case statement is unambiguous on read (`else status end`), so a code-review pass is sufficient unless the trigger gets rewritten.

## Row 53 — stuck_in_progress dashboard rule

**Setup:** Fresh proof + minimal v1, status `in_progress`, force `last_activity_at = '2026-04-20'` (20 calendar days ago, 14 business days).

**Action:** Call `proofs_needing_attention()` RPC.

**Expected:** Proof appears in the result with `rule_code = 'stuck_in_progress'` because (a) status is `in_progress`, (b) no `proof_events` rows in the last 10 days, (c) no `proof_version_views` rows in the last 10 days, (d) `business_days_between(last_activity_at::date, now()::date)` exceeds the 10-day threshold.

**Observed:** Match. `{"proof_id": "7ecfb4cb-...", "rule_code": "stuck_in_progress", "rule_meta": {"days": 14}}`.

Pass. Migration 000154's rule body and the seeded threshold (10 business days) agree.

## Row 60 — reply template DEFAULT_BODIES vs DB

**Approach:** Read `src/lib/replyTemplates.ts` `DEFAULT_BODIES` constant. Read all 5 rows from `reply_templates` table via service-role REST. Diff each body byte-for-byte.

**Expected:** All 5 match — code constant matches what the migrations seeded, so the admin "Reset to default" button is a no-op against pristine DB state.

**Observed:** All 5 match (`first_proof`, `revision`, `proof_approval_confirmation`, `proof_change_request_confirmation`, `proof_variant_selection_confirmation`). Zero diff.

Pass. The CLAUDE.md claim "Default bodies mirror src/lib/replyTemplates.ts DEFAULT_BODIES" holds.

## Methodology and limitations

This sweep was DB / RPC layer only. Specifically:

- No browser walks. The customer page, designer dashboard, admin UI all went unexercised. UI-only bugs (visual regressions, click handlers wired to wrong actions, state staleness) wouldn't be caught.
- No edge function POSTs. Row 28 verified the lock at the constraint level and read the edge function source for the application-level check, but didn't actually POST through `/functions/v1/proof-action`. A bug in request parsing, auth flow, or response shape wouldn't be caught here.
- No HS API verification. Rows 24 / 27 / 28 (which trigger HS confirmation replies) weren't on this slice; the seeded reply template content is verified (Row 60), but the actual posting of the reply through Help Scout is not.

What this sweep did cover well: triggers, state machines, unique constraints, business-rule SQL functions, code-vs-DB coherence. The reopen-class bug (000158) lived in this layer, and the layer is currently clean across the rows tested.

## Open candidate slices for next time

If the next sweep wants to find more bugs, surfaces that haven't been touched yet by either pass:

- **Help Scout reply posting:** Rows 24, 27, 28 — do confirmation replies actually land in HS conversation 422593 with the correct rendered body?
- **Designer flow on the new-proof form:** Rows 33–38 — URL-paste, multi-match picker, override-reason panel, the partial-success retry path that PR #46 only partially fixed.
- **Per-option-tab image filtering on the customer page:** Row 42 — does changing images on edit correctly filter by option tab?
- **Variant rounds with per-direction-pricing (rows 20, 21):** Hides the docket entirely when on; a regression here would silently expose internal pricing details.
- **Letterpress core/front/back colour rendering (Row 14):** Customer page renders a layered Colorplan cross-section; visual regression risk.

These are mostly UI / edge-function paths where the DB-only methodology this sweep used wouldn't help. Browser sanity (Chrome MCP) or curl POSTs to the edge function would be the next escalation.
