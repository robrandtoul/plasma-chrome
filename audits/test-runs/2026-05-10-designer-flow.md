# Designer flow — new-proof form (Rows 33–38) — 2026-05-10

Code-review + HTTP-verification pass. No browser available during this session (computer-use approval timed out — Rob was out). Browser-dependent rows are marked **[needs-browser]** with a specific confirmation target; everything else was fully verified from source and live HTTP.

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 33 | pass (code review) | Manual picker path: state machine correct, all PR #45/#46 hygiene fixes on main |
| 34 | pass (code review) | `?contactId=` prefill: company resolved, contact matched via ref pattern, email-driven lookup fires |
| 35 | pass (code review) | `?companyId=` prefill: company resolved, contact picker focused, email-driven lookup fires on contact select |
| 36 | pass (code review) + partial HTTP | URL-paste edge function auth-gated; parse logic handles URL/short-number/long-number correctly |
| 37 | **[needs-browser]** | Multi-match picker: code path confirmed correct; live behaviour depends on how many active/pending HS threads `proofviewertest@icloud.com` has |
| 38 | pass (code review) | Zero-matches → override panel fires; 10-char minimum enforced client-side; submit blocked without URL or reason |

Two P3 findings; no P1 or P2.

---

## Context

Rows 33–38 cover the designer new-proof form (`/proofs/new`) at three entry layers:

- **Manual** (rows 33–35): picker-driven company/contact selection ± URL params
- **Paste-from-Help-Scout** (row 36): primary entry point, calls `lookup-helpscout-conversation` edge function
- **Email-driven auto-link** (rows 37–38): fires when `selectedContact.id` changes, calls `match-helpscout-conversation`

PRs #45 and #46 shipped between the first-pass test (2026-05-09) and this session. The code reviewed here is post-fix.

---

## Edge function auth verification (HTTP, live)

Both designer-gated edge functions confirmed working at auth layer:

**No auth header:**
```
POST /functions/v1/lookup-helpscout-conversation → 401
POST /functions/v1/match-helpscout-conversation  → 401
```

**Anon key (not a designer JWT):**
```
POST /functions/v1/lookup-helpscout-conversation → {"error":"Unauthorized"}
POST /functions/v1/match-helpscout-conversation  → {"error":"Unauthorized"}
```

**CORS preflight:**
```
OPTIONS /functions/v1/lookup-helpscout-conversation → 200
OPTIONS /functions/v1/match-helpscout-conversation  → 200
```

`requireDesigner` (in `_shared/admin.ts`) validates: bearer JWT → `auth.getUser()` → checks `profiles.role IN ('admin','designer')` AND `deactivated_at IS NULL`. Anon key has no user context so `getUser()` fails → 401. Any authenticated user with a non-staff role would get 403. ✅

---

## Row 33 — manual contact picker

**Path:** Designer opens `/proofs/new` with no params. Uses the company combobox, then the contact combobox, optionally adds a new contact. Pastes a HS conversation URL manually or uses the paste-first box.

**Code review:**

- Companies load on mount, contacts load when `selectedCompany?.id` or `isIndividual` changes. State resets (contacts, selectedContact, search strings) happen at the top of the contact-load effect on every run. ✅
- `allCompanies` is now appended on successful company insert (PR #45 / commit `a4fcadf`). On a partial-success retry (proof insert fails, designer stays on form), the picker reflects the new company and doesn't offer "Add new company" again. ✅
- `selectedCompany.id` is now promoted from `null` to the DB id after successful insert (PR #46 / commit `445bac3`). On retry, the insert branch is skipped. ✅
- `allContacts` is now appended on successful contact insert (PR #46 / commit `75d321d`). ✅

**Known remaining gap (documented in PR #46 body):** `selectedContact` is not promoted after a new-contact insert. If the proof insert fails and the designer retries, the contact-insert branch re-fires with the same email and hits 23505. The contact picker entry is now in `allContacts` (from the append), but the form stays in add-mode, not pill-mode. Fix requires a UX decision (collapsing add-mode fields mid-edit). Parked from PR #46 scope. ✅ (documented, not a new finding)

---

## Row 34 — `?contactId=` param

**Path:** `/proofs/new?contactId=<uuid>` — pre-fills company and contact; email-driven HS lookup then fires automatically.

**Code review:**

```typescript
// applyPrefill effect (mount-only):
const { data } = await supabase.from('contacts')
  .select('id, full_name, email, company_id, companies(id, name)')
  .eq('id', prefillContactId)
  .single()
// → setSelectedCompany / setIsIndividual based on contact's company
// → pendingContactPrefillRef.current = prefillContactId

// contact-load effect fires (selectedCompany changed):
// → fetches contacts for the company
// → finds contact matching pendingContactPrefillRef → setSelectedContact(match)

// selectedContact?.id change triggers:
// → runHelpscoutLookup(selectedContact.email) → match-helpscout-conversation
```

The prefill ref is consumed on the first successful contact-load pass. If the contact is an individual, `setIsIndividual(true)` triggers a load of all contacts-without-company, where the ref is consumed. ✅

**Observed risk:** `pendingContactPrefillRef` is not sticky (unlike `pendingPasteNewContactRef`). If an identity flip happens after prefill (e.g. a future "flip individual mode" flow), the ref is already consumed and can't re-apply. The code comment at line 73 calls this out explicitly. Not a current bug but worth awareness.

---

## Row 35 — `?companyId=` param

**Path:** `/proofs/new?companyId=<uuid>` — pre-fills company only; contact picker opens and focuses.

**Code review:**

```typescript
// applyPrefill effect:
const { data } = await supabase.from('companies').select('id, name').eq('id', prefillCompanyId).single()
setSelectedCompany({ id: data.id, name: data.name })
setCompanySearch(data.name)

// pendingFocusContactRef is set to true when companyId param is present but contactId is not.
// contact-load effect fires:
// → fetches company contacts
// → if pendingFocusContactRef.current: setContactOpen(true) + focus on contactInputRef
```

Contact picker opens and focuses automatically when there are contacts to choose from. If the company has no contacts, the form drops into add-new mode (existing behaviour: `contacts.length === 0 → setAddingContact(true)`). ✅

**Note on email-driven lookup:** Unlike row 34 (contact pre-selected), this path only fires the HS lookup once the designer actually picks or adds a contact. No autofire on company-only prefill. Correct — there's no email to look up yet.

---

## Row 36 — paste-from-Help-Scout (URL or number)

**Entry point:** "Start from Help Scout" panel at the top of the form. Calls `lookup-helpscout-conversation`.

**`parsePasteInput` logic (source, verified by code trace):**

| Input shape | Result |
|-------------|--------|
| `https://secure.helpscout.net/conversation/3307718805` | `{ conversationId: '3307718805' }` |
| `https://secure.helpscout.net/conversation/3307718805/` (trailing slash) | `{ conversationId: '3307718805' }` — non-anchored regex strips trailing path |
| `422593` (≤8 digits) | `{ conversationNumber: '422593' }` — short number path |
| `3307718805` (>8 digits) | `{ conversationId: '3307718805' }` — big ID path |
| `420859` | `{ conversationNumber: '420859' }` |
| `not-a-number` | `null` → paste error shown |

Short-number path calls `resolveNumberToId` in the edge function (HS search by `(number:N)`) then fetches the full conversation. Big-id path fetches directly. Both end at `fetchConversation(token, id)` + `fetchCustomer(token, customer.id)`. ✅

**`applyPasteResult` after successful lookup:**

1. Sets HS link state (`hsConversationId`, `helpscoutUrl`, `hsLinkedSubject`)
2. Looks up existing contact by email (cross-company, case-insensitive via pre-stored lowercase)
3. If existing: sets company/individual from DB record, sets `pendingContactPrefillRef` → contact-load effect re-picks the contact
4. If new: sets `pendingPasteNewContactRef` (sticky) → company resolved from HS `organization` field → contact-load effect enters add-mode with pre-filled name + email
5. Auto-expands the manual disclosure (`setManualOpen(true)`) so the designer reviews what landed

The sticky ref (`pendingPasteNewContactRef`) survives identity flips: if the designer unticks "No company" after a paste of a customer with no HS organization, the form doesn't wipe the pre-filled name + email. ✅

**Finding PV-2026W20-001 (P3 — audit log):** The `source` field in the `proof.helpscout_link_set` audit event is derived from `pasteSubject != null`. `pasteSubject` is set to `result.subject ?? null`. When a HS conversation has no subject (rare, possible on old/spam threads), `pasteSubject` is null and the source evaluates to `'auto'` or `'picker'` rather than `'paste'`. Minor logging inaccuracy; no customer-visible impact.

**[needs-browser]** Full happy-path confirmation: paste a real HS URL, verify company/contact pre-fill, verify manual disclosure opens, verify "Found: `<subject>`" green banner renders.

---

## Row 37 — contact with multiple HS conversations (multi-match picker)

**Code path (verified):**

`runHelpscoutLookup(email)` → `match-helpscout-conversation` → returns `matches: []` → form dispatches:
- `matches.length === 0` → `clearHelpscoutLink()`, `setHsLookupReturnedZero(true)` (Row 38 path)
- `matches.length === 1` → `applyHelpscoutMatch(matches[0])` (auto-link)
- `matches.length > 1` → `setHsPickerMatches(matches)`, `setHsPickerOpen(true)` (this row)

`HelpScoutPicker` modal renders each match as a button with subject, status (emerald if active), mailbox name, and modifiedAt date. Status badge uses colour-coding: `active` → emerald, other → grey. "These aren't right — I'll provide a reason" escape hatch calls `useOverrideInsteadOfPicker()`, which closes the picker and triggers the override panel (Row 38 path). ✅

**[needs-browser]** Live trigger condition: `match-helpscout-conversation` only returns `active` or `pending` conversations. For the picker to fire, `proofviewertest@icloud.com` needs ≥2 active/pending threads in HS. Standard test conversation 422593 may be the only active thread for this contact. If so, Row 37 can only be exercised by:
  - (a) creating a second test conversation in HS for `proofviewertest@icloud.com`, or
  - (b) using a different contact known to have multiple open threads

Check HS before this test to confirm 422593's status and whether any other threads exist for the contact.

---

## Row 38 — contact with no HS conversations (override-reason panel)

**Code path (verified):**

Zero matches from `match-helpscout-conversation` → `clearHelpscoutLink()`, `setHsLookupReturnedZero(true)`.

Override panel renders when `hsLookupReturnedZero && !hsConversationId`. Panel copy: "No Help Scout conversation linked" + "No matches found for `<email>`." + override reason textarea.

Submit validation:
```typescript
if (!parsedUrl && reason.length < MIN_OVERRIDE_REASON_LENGTH) {
  setError(`Pick a Help Scout conversation, or provide an override reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.`)
  scrollToHelpscout()
  return
}
```

`MIN_OVERRIDE_REASON_LENGTH = 10`. DB check constraint only enforces that *some* override reason exists, not its length — the 10-char minimum is client-side only. ✅

Submit with a valid override reason writes `helpscout_override_reason` to the proof row, `helpscout_conversation_id` and `helpscout_conversation_url` both null. An `audit_log` event of type `proof.helpscout_override_set` is emitted with `{ reason, lookup_email }`. ✅

**Finding PV-2026W20-002 (P3 — URL field UX):** `parseHelpscoutUrl` (used for the manual URL field in the Internal section) uses a strict end-anchored regex: `/^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)$/`. A URL with a trailing slash (e.g. `https://secure.helpscout.net/conversation/12345/`) fails this check and shows a format error. But `parsePasteInput` (used for the "Start from Help Scout" paste box) uses a non-anchored regex and accepts the same URL. Designers copying the URL from the browser address bar may occasionally include a trailing slash or query string; pasting into the right box works, the wrong box does not. Low-severity — the form has good error copy pointing to the correct field — but the inconsistency could cause confusion.

**[needs-browser]** Confirm the override panel's character counter (`N / 10 characters`) and the transition from "N / 10" to "OK" at ≥10 chars renders correctly. Confirm Create project is blocked until the threshold is met.

---

## TypeScript

```
$ npx tsc --noEmit   (in proof-viewer/)
(no output)
```

Zero type errors across the codebase at the current main HEAD. ✅

---

## PR coverage of Rows 33–38

| PR | What it fixed | Relevant to |
|----|---------------|-------------|
| #45 | `allCompanies` cache stale after insert | Row 33 partial-success |
| #46 | `selectedCompany.id` promoted after insert; `allContacts` cache stale after insert | Row 33 partial-success |
| #47 | Authenticated session view events skipped (CustomerProofPage) | Not rows 33–38 |

All fixes are on main. No pending branches touching `NewProofPage.tsx` or the two HS edge functions.

---

## Open items for next browser session

1. **Row 37 trigger:** Check HS whether `proofviewertest@icloud.com` has ≥2 active/pending conversations. If not, create a second test thread before running the picker path.
2. **Row 36 happy path:** Live smoke-test: paste `https://secure.helpscout.net/conversation/422593` (or the conversation number), confirm pre-fill works end to end, confirm green "Found" banner, confirm Create project succeeds.
3. **Row 33 partial-success retry:** Needs a deliberate force-failure (e.g. pass a new company name + new contact, then temporarily break the proof insert to stay on the form). Confirm the company row is in the picker and 23505 is no longer thrown.
4. **Row 38 UI:** Confirm override panel renders correctly, character counter works, and submit is gated until 10 chars.
5. **PV-2026W20-002 UX test:** Paste `https://secure.helpscout.net/conversation/422593/` (with trailing slash) into both the paste box (should work) and the manual URL field (should show format error). Confirm the error copy is actionable.

---

## Findings

### PV-2026W20-001 — Paste source misclassified in audit log when conversation has no subject
- **Severity:** P3
- **Area:** Help Scout integration
- **File:** `src/pages/NewProofPage.tsx` line ~800
- **Description:** The `source` field in `proof.helpscout_link_set` audit events is determined by `pasteSubject != null`. `pasteSubject` is set to `result.subject ?? null`, so a HS conversation with a null subject (rare but possible) causes source to evaluate as `'auto'` or `'picker'` rather than `'paste'`. No customer-visible impact; audit log is slightly inaccurate.
- **Proposed fix:** Track paste success separately from the subject: `const [pasteWasUsed, setPasteWasUsed] = useState(false)`, set to `true` in `applyPasteResult`, use in the source expression instead of `pasteSubject`.
- **Auto-applied:** false

### PV-2026W20-002 — Trailing-slash HS URL accepted in paste box but rejected in manual URL field
- **Severity:** P3
- **Area:** Help Scout integration / UX
- **Files:** `src/lib/helpscout.ts` (HELPSCOUT_URL_REGEX), `src/pages/NewProofPage.tsx` (parsePasteInput)
- **Description:** `parseHelpscoutUrl` uses `/^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)$/` (end-anchored). `parsePasteInput` uses `/^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)/` (not end-anchored). A URL with a trailing slash or fragment works in the paste box but fails the manual URL field with a format error.
- **Proposed fix:** Either (a) strip a trailing slash in `parseHelpscoutUrl` before matching, or (b) update `HELPSCOUT_URL_REGEX` to accept an optional trailing slash: `(\d+)\/?$`. Option (a) is simpler and least likely to have knock-on effects.
- **Auto-applied:** false

---

## What this sweep did not cover

- **Live browser testing of any row:** Dev server requires Rob's machine; computer-use access timed out. All passing rows are code-review verified, not behaviorally verified.
- **Row 37 multi-match picker live trigger:** Depends on HS state of test contact. Can't verify without a browser and HS access.
- **Paste-from-HS edge function with a real designer JWT:** Both functions correctly reject non-designer calls (verified). Confirmed live with a valid designer token requires Rob's session.
- **`?contactId` / `?companyId` param prefill in the browser:** Routes are code-correct; live UX flow not smoke-tested.
