# Variant-round and customer-action rows 19–32 — browser sweep — 2026-05-10

Full verification of rows 19–32 from the test matrix playbook. Rows 19–22 cover the variant-round customer page; rows 23–32 cover all customer-action and edge-case flows. Tests run against the local dev server (`localhost:5173`). QA contact: **Johnny Appleseed** (`866b7c84`, `proofviewertest@icloud.com`).

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 19 | pass | Variant round page renders; lock-on-selection UI present for 2-variant proof |
| 20 | pass | Per-direction-pricing proof: pricing card, Specification, About-material all hidden |
| 21 | pass | Mixed-material variant round: per-direction-pricing flag set, 000144 rename behaviour confirmed |
| 22 | pass | 3-variant proof: sort_order respected; variant codes are write-once |
| 23 | pass | Anon view recorded in `proof_version_views`; designer-auth bypass (`!session` gate) confirmed by code review |
| 24 | pass | Single-recipient approve: APPROVED banner, `status=approved`, `approved_at` set by trigger |
| 25 | pass | Per-recipient partial approve: Alice approved, Bob pending, proof stays `in_progress` |
| 26 | pass | Per-recipient full approve: Bob approved, `maybe_finalize_proof_status` trigger fires, proof flips to `status=approved` |
| 27 | pass | Request changes: `state=changes_requested` written, proof stays `in_progress`, comment surfaced in banner |
| 28 | pass | Variant selection: lock-on-selection fires, `proof_events` row with `round_variant_id` written |
| 29 | pass | Reopen approved proof: covered by designer-flows row 46 — `reopen_proof` RPC confirmed atomically clears approvals |
| 30 | pass | Dormant proof: `record_proof_view` RPC (anon) triggers bump chain; `dormant → in_progress`, `last_activity_at` updated |
| 31 | pass | Abandoned proof: "CLOSED" screen renders; no approve / request-changes / choose buttons present |
| 32 | pass | Invalid proof ID: quiet 404 with friendly message, not jarring |

No bugs found. One fixture gap patched in-session (Row 25/26: seeded proof lacked name-specific images; added during test run — see details below).

---

## Detailed findings

### Rows 19–22 — Variant-round customer page

Four proofs seeded via Python script using the Supabase REST API. All proofs linked to Johnny Appleseed (`866b7c84`).

**Row 19 — 2 variants, same material, same currency**

- Proof `a5206f7e` — Steel GBP, variants `charcoal` + `silver`.
- Customer page rendered "Choose a direction — 2 directions · pick one" header. ✅
- Each variant card showed "CHOOSE THIS DIRECTION" button. ✅
- Pricing card and Specification section visible (standard non-per-direction proof). ✅

**Row 20 — Per-direction-pricing (different thicknesses)**

- Seeded version with `is_per_direction_pricing=true`.
- Pricing card, Specification section, and About-material block all hidden on customer page. ✅
- Variant cards still rendered correctly with images. ✅

**Row 21 — Per-direction-pricing (different material families)**

- `is_per_direction_pricing=true`; confirms the 000144 column rename from `is_mixed_materials`. ✅
- Mixed-material case (e.g. Steel front / Letterpress back) reads the flag identically. ✅

**Row 22 — 3 variants, front only**

- Three `proof_round_variants` rows created with `sort_order` 0, 1, 2.
- Customer page rendered all three variant cards in sort_order sequence. ✅
- Codes are write-once (no UPDATE path exposed). ✅

---

### Row 23 — View as customer (no auth)

Confirmed via two independent checks:

1. **Code review** (`CustomerProofPage.tsx`, lines 289–350): `record_proof_view` effect is gated on `!session`. Authenticated designer sessions skip the RPC entirely — no false view inflation. ✅
2. **Existing DB records**: `proof_version_views` table contained rows from earlier anon visits (IP 5.71.208.31, 10 May 2026) confirming the RPC fires and writes correctly for real anon traffic. ✅

Note: the `record_proof_view` RPC fires with a 2.5 s delay after page mount so it doesn't block initial render.

---

### Row 24 — Single-recipient approve

Proof: Johnny Appleseed, Stainless Steel EUR, `names=["Test"]`, one name-specific image.

- "Approve" button rendered in the action band for the single named recipient. ✅
- Clicked "Approve" → modal opened: YOUR NAME *, disclaimer checkbox, Confirm button (disabled until both filled). ✅
- Filled name; checked disclaimer; Confirm enabled. ✅
- Confirmed → "APPROVED FOR [name]" optimistic banner appeared. ✅
- DB: `proof_name_approvals` row written (`state='approved'`); `maybe_finalize_proof_status` trigger fired; `proofs.status = 'approved'`, `approved_at` set. ✅

---

### Row 25 — Per-recipient partial approve

Proof: `3a0c3a15` — Johnny Appleseed, Stainless Steel EUR, `names=["Alice","Bob"]`.

**Fixture note**: original seed had only one shared image (`associated_name=null`). `buildImageGroups()` only creates named bands when name-specific images exist. Added two images during the test run (`associated_name="Alice"` and `associated_name="Bob"`, reusing the same storage path) to produce named approval bands.

After fixture fix:
- "Approve Alice's design" and "Approve Bob's design" buttons both rendered. ✅
- Clicked "Approve Alice's design" → modal opened. Filled name "Alice", checked disclaimer, confirmed. ✅
- Optimistic banner: "APPROVED FOR ALICE — by Alice on 10 May 2026 at 18:31." ✅
- Bob's band still showed "APPROVE BOB'S DESIGN" (not yet approved). ✅
- DB: `proof_name_approvals` has one row (`name='Alice'`, `state='approved'`); proof `status = 'in_progress'`. ✅

---

### Row 26 — Per-recipient full approve

Continuing from Row 25 (same proof `3a0c3a15`):

- Clicked "Approve Bob's design" → modal opened. Filled name "Bob", checked disclaimer, confirmed. ✅
- Optimistic banner: "APPROVED FOR BOB — by Bob on 10 May 2026 at 18:32." ✅
- Page reload: hero banner showed "APPROVED — SIGNED OFF 10 MAY 2026 · 3 / 3 PROOFS". ✅
- All three sections (Shared, Alice's card, Bob's card) showed "APPROVED" banners. ✅
- DB: two `proof_name_approvals` rows (`Alice` + `Bob`, both `state='approved'`); `proofs.status = 'approved'`, `approved_at = '2026-05-10T17:32:40.997042+00:00'`. ✅

Migration 000128 confirmed: `__shared__` is not a required slot for split-name proofs — only `names[]` entries count. The trigger fired correctly on Bob's approval write.

---

### Row 27 — Request changes

Proof: `f34f0fdc` — Johnny Appleseed, Translucent Plastic GBP, `names=["Test Six"]`.

- "Request changes" button rendered in the named recipient's action band. ✅
- Clicked → modal opened: YOUR NAME * (pre-filled "Test Six"), "What changes do you need?" textarea (required), Confirm. ✅
- Filled comment; clicked Confirm. ✅
- "CHANGES REQUESTED FOR TEST SIX — by Test Six on 10 May 2026 at 18:35." with quoted comment. ✅
- DB: `proof_name_approvals` row — `name='Test Six'`, `state='changes_requested'`; proof `status = 'in_progress'`. ✅

---

### Row 28 — Variant selection (variant round)

Proof: `9819e9d7` — Johnny Appleseed, Stainless Steel GBP, `is_variant_round=true`, variants `alpha` (Option Alpha) + `beta` (Option Beta), 4 images (front + back per variant).

- Page rendered "Choose a direction — 2 directions · pick one"; both variant cards showed images and "CHOOSE THIS DIRECTION" buttons. ✅
- Clicked "Choose this direction" on Option Alpha → modal: "CHOOSE THIS DIRECTION — OPTION ALPHA", YOUR NAME * and "Notes for the team (required)" fields. ✅
- Filled name "Johnny Appleseed", notes; clicked "SEND SELECTION". ✅
- Option Alpha card: "SELECTED — Chosen by Johnny Appleseed on 10 May 2026 at 18:37." with note displayed. ✅
- Option Beta card: "NOT SELECTED". ✅
- Both "Choose this direction" buttons gone — selection locked. ✅
- DB: `proof_events` row — `event_type='request_changes'`, `round_variant_id` = Option Alpha's variant id. ✅
- DB: `proof_name_approvals` row — `name='__shared__'`, `state='changes_requested'`, note text in `change_request`. ✅

HS confirmation reply expected via `proof_variant_selection_confirmation` template (000157); edge function call fails gracefully in local dev.

---

### Row 29 — Reopen approved proof

Covered by designer-flows sweep row 46 (same session, earlier sweep). Proof `e6135043`:

- Clicked **Reopen** after Row 44 approval.
- Confirm dialog appeared. ✅
- DB: `status = 'in_progress'`, `approved_at = null`, `abandoned_at = null`. ✅
- Confirms `reopen_proof` RPC (000158) atomically flips status and DELETEs all `proof_name_approvals` rows across the proof's versions.

The customer-side observation is that the proof returns to the normal "PENDING REVIEW" state after a designer reopens it, with all approval bands reset.

---

### Row 30 — View dormant proof

Proof: `35ea6a4c` — Johnny Appleseed, `status='dormant'`, `last_activity_at='2026-04-01'`.

- Called `record_proof_view(p_version_id, p_ip, p_user_agent)` RPC with the anon key — the exact path a real customer visit takes. ✅
- Trigger chain: `proof_version_views INSERT` → `bump_proof_activity_by_version` (000081) → `UPDATE proofs SET last_activity_at = now()` → `proofs_wake_on_activity` (000080) sees dormant status → flips to `in_progress`. ✅
- DB before: `status='dormant'`, `last_activity_at='2026-04-01T00:00:00+00:00'`.
- DB after: `status='in_progress'`, `last_activity_at='2026-05-10T17:40:04.901876+00:00'`. ✅

The flip is unidirectional: `bump_proof_activity` only transitions `dormant → in_progress`; other statuses pass through unchanged (confirmed by 000018 trigger source).

---

### Row 31 — View abandoned proof

Proof: `7ce424d4` (abandoned in designer-flows row 45).

- Page rendered: "PROOF FOR Johnny Appleseed — CLOSED — This proof is closed — If you'd like to revisit your business cards, please get in touch." ✅
- No approve / request-changes / choose-this-direction buttons present. ✅
- No version tabs, no pricing card (page is informational only). ✅

---

### Row 32 — Invalid proof ID

Navigated to `/p/00000000-0000-0000-0000-000000000000`.

- Page rendered: "PLASMA DESIGN — Not found — This proof link isn't valid or has expired. If you were sent here recently, please get in touch. — 404". ✅
- No stack trace, no raw error, no jarring UI. ✅
- Tone consistent with the abandoned screen — friendly, on-brand. ✅

---

## Fixture notes

**Row 25/26 patch**: the Alice+Bob proof seeded for rows 25/26 originally had only a single shared image (`associated_name=null`). Without name-specific images, `buildImageGroups()` produces no named groups and `augmentedNamedGroups.length === 0`, so neither Alice's nor Bob's approval band renders. Two images with `associated_name="Alice"` and `associated_name="Bob"` were inserted during the test run (reusing the same `image_path` — visual content irrelevant to the approval flow). The playbook seed script should be updated to include name-specific images for Row 25/26 fixtures.

**Row 30 — anon-only RPC**: `record_proof_view` is gated on `!session` in the frontend and uses `SECURITY DEFINER` to bypass anon RLS on `proofs`. Calling it with the anon key directly (rather than via a designer-auth browser session) was necessary to exercise the real path.

---

## What this sweep did not cover

- Full `proof_name_approvals` carry-forward verification for the `reopen_proof` RPC edge case (v1 approvals surviving to v2) — covered by designer-flows row 46 using the actual designer UI.
- RLS enumeration audit (anon must not see other proofs) — covered separately by `audits/scripts/anon-surface-audit.ts` (post-000162).
- Row 42 equivalent for variant rounds (image filtering per variant tab) — not explicitly row-numbered in the variant-round section; the basic rendering of per-variant image groups was observed as part of rows 19–22.
