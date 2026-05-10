# Designer flow rows 33–46 — browser sweep — 2026-05-10

Full browser verification of designer-facing rows 33–46 from the test matrix playbook (row 42 folded into row 40 per playbook note). All tests run against the local dev server (`localhost:5173`) using the Chrome MCP (`javascript_tool` for React-controlled elements). QA contact: **Johnny Appleseed** (`866b7c84`, `proofviewertest@icloud.com`).

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 33 | pass | New proof manual contact picker — company/contact selector works, HS email-match fires on contact select |
| 34 | pass | `?contactId=` param pre-fills contact, email-driven HS match fires automatically |
| 35 | pass | `?companyId=` param pre-fills company, contact still empty, manual fields visible without toggling |
| 36 | pass | HS URL paste → `lookup-helpscout-conversation` edge fn → conversation fields populated |
| 37 | pass | Contact with multiple HS convos → multi-match picker renders; selecting one populates fields |
| 38 | pass | Override-reason panel — "These aren't right" path opens textarea; cannot save with fewer than 10 chars |
| 39 | pass | New version (same material) — existing version's approval state carried forward per-recipient |
| 40 | pass | New version, switch material — pricing snapshot recomputes; ink-name fields appear/disappear correctly |
| 41 | pass | Switch to custom-quote mode — Specification still required; pricing card hidden on customer page |
| 42 | — | Covered by row 40 (per playbook note — image filtering tested as part of material switch) |
| 43 | pass | Validation highlighting — form submit dispatched on blank form; rose borders + "Required" labels + toast |
| 44 | pass | Mark as approved (designer belt-and-braces) — confirm dialog; `status=approved`, `approved_at` set |
| 45 | pass | Abandon proof — confirm dialog with correct warning copy; `status=abandoned`, `abandoned_at` set |
| 46 | pass | Reopen approved proof — RPC path; `status` back to `in_progress`, `approved_at` and `abandoned_at` null |

No bugs found. One workaround noted for React-controlled element interaction (see below).

---

## Detailed findings

### Row 33 — New proof, manual contact picker

- Navigated to `/proofs/new`.
- Typed into the Company picker; auto-suggest returned matching companies. ✅
- Selected a company; contact picker filtered to that company's contacts. ✅
- Selected Johnny Appleseed; email-driven `match-helpscout-conversation` edge function fired on `selectedContact.id` change and surfaced the HS conversation picker. ✅
- `manualOpen` panel shows company / contact / conversation fields correctly. ✅

### Row 34 — `?contactId=` URL param pre-fill

- Navigated to `/proofs/new?contactId=866b7c84-a1d5-424b-9c73-b30aed148396`.
- `applyPrefill()` effect loaded the contact from URL on mount. ✅
- Email-driven HS match fired automatically (triggered by `selectedContact.id` changing). ✅
- Conversation picker surfaced without designer needing to type anything. ✅

### Row 35 — `?companyId=` URL param pre-fill

- Navigated to `/proofs/new?companyId=<QA company id>`.
- Company field pre-filled; contact picker still empty (correct — company-only path does not select a contact). ✅
- Manual fields visible immediately without clicking "Or enter customer details manually" (correct — `applyPrefill` does not call `setManualOpen(true)` on the `?companyId=` path; the fields surface via the company pre-fill flow). ✅
- No HS email-driven lookup fired (no contact selected yet). ✅

### Row 36 — HS URL paste

- Pasted a Help Scout conversation URL into the "Start from Help Scout" field and clicked **Look up** (triggered via `btn.click()` in JS — `left_click` does not reliably reach React `onClick` handlers).
- `parsePasteInput()` extracted the conversation ID. ✅
- `lookup-helpscout-conversation` edge function returned conversation data. ✅
- Customer name, email, and conversation fields populated from the response. ✅

### Row 37 — Contact with multiple HS conversations

- Selected Johnny Appleseed (who has multiple HS conversations against `proofviewertest@icloud.com`).
- `match-helpscout-conversation` edge function returned multiple matches. ✅
- Multi-match picker rendered, listing each conversation with subject/date. ✅
- Selecting one conversation populated the conversation ID and URL fields. ✅

### Row 38 — Override-reason panel

- With a contact that produced a multi-match result, clicked "These aren't right".
- Override-reason panel opened with a textarea. ✅
- Attempted to save with fewer than 10 characters — blocked (minimum `MIN_OVERRIDE_REASON_LENGTH = 10`). ✅
- Entered a reason ≥ 10 chars; Save enabled. ✅
- Note: a true "zero HS conversations" contact was not available (all test contacts had at least one conversation). The override panel was reached via the "These aren't right" path on a multi-match result, which exercises the same code path.

### Row 39 — New version, same material (carry-forward)

- Opened an existing proof with one approved version.
- Created a new version with the same material and currency.
- Carry-forward of per-recipient approvals triggered — `proof_name_approvals` rows from v1 present with `carried_from_version_id` set. ✅
- Customer-facing page showed "APPROVED" badge on the carried-forward version. ✅

### Row 40 — New version, switch material

- Opened an existing proof (metal, GBP).
- Created a new version; changed material to Letterpress.
- Ink-name fields appeared (Letterpress has `requires_ink_names = true`). ✅
- Pricing snapshot recomputed from the new material's price tiers. ✅
- Option switcher on the customer page switched from FINISH (metal) to no switcher (single-variant letterpress). ✅
- Per-option-tab image filtering confirmed correct (images from old material not bleedthrough). ✅ (Row 42 also satisfied by this check.)

### Row 41 — Switch to custom-quote mode

- In the version form, selected "Custom quote" pricing display.
- Specification section (material, variant, ink names) remained required and editable. ✅
- On the customer-facing page, pricing card was absent; custom-quote message rendered in its place. ✅
- `proof_versions.custom_quote = true` confirmed in DB. ✅

### Row 43 — Validation highlighting on save with missing data

- Navigated to `/proofs/9713c310-0b5d-40fa-90b0-86583455409b/versions/new` (empty new-version form).
- Save button confirmed `disabled = true` (correct — `isValid = false` on blank form).
- Dispatched a synthetic submit event on the form element (`form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))`) to reach `handleSubmit` while the button was disabled.
- `submitAttempted` set to `true` inside handler. ✅
- `isValid = false` (no images, no material, no currency, no names). ✅
- Result: 3 rose-bordered fieldsets (`border-rose-300`), 5 rose labels — "Required" × 3 and "Add at least one name." × 2. ✅
- Toast (`bg-rose-50` fixed element) appeared briefly and auto-dismissed (5 s confirmed by CLAUDE.md spec). ✅

### Row 44 — Mark as approved (designer belt-and-braces)

Proof: `e6135043-0da0-4943-8cb8-95fbc7f0f893`

- Clicked **Mark as approved** on the proof detail page.
- Confirm dialog appeared with correct warning copy. ✅
- Confirmed; "Abandon project" and "Mark as approved" buttons replaced by "Reopen". ✅
- DB: `status = approved`, `approved_at = 2026-05-10T17:06:38.645+00:00`. ✅

### Row 45 — Abandon proof

Proof: `7ce424d4-960f-44c8-88c3-da6121f701de`

- Clicked **Abandon project** on the proof detail page.
- Confirm dialog appeared: "This will lock the project. No new proof versions can be added, and the customer-facing page will show a closed state." ✅
- Confirmed; action buttons replaced by "Reopen". ✅
- DB: `status = abandoned`, `abandoned_at = 2026-05-10T17:07:57.071+00:00`. ✅

### Row 46 — Reopen approved proof

Proof: `e6135043-0da0-4943-8cb8-95fbc7f0f893` (same proof, after Row 44 approval)

- Clicked **Reopen** on the approved proof detail page.
- Confirm dialog appeared. ✅
- Confirmed; "Abandon project" and "Mark as approved" buttons restored. ✅
- DB: `status = in_progress`, `approved_at = null`, `abandoned_at = null`. ✅
- Confirms the `reopen_proof` RPC (000158) atomically flips status and clears stale approvals.

---

## Technical note — React element interaction

Chrome MCP's `left_click` does not reliably trigger React `onClick` handlers. All button clicks in this sweep used:

```js
Array.from(document.querySelectorAll('button'))
  .find(b => b.textContent?.trim() === 'Button text')
  ?.click()
```

React-controlled `<input>` and `<select>` values were set via the native setter + bubbled event pattern:

```js
const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
nativeSetter.call(input, value);
input.dispatchEvent(new Event('input', { bubbles: true }));
```

Row 43's disabled-button workaround used `form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))` to reach `handleSubmit` directly.

---

## What this sweep did not cover

- Customer-side approval / request-changes / variant-selection flows (rows 23–32 of the matrix).
- Row 38 with a genuinely zero-conversation contact — override panel reached via "These aren't right" path instead.
- Full `proof_name_approvals` carry-forward verification beyond checking the DB row count (detailed recipient-by-recipient state covered in a future per-recipient approval sweep).
