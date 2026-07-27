# Artwork sanity-check — build spec

Assessed, grounded on live data, prototyped, and backtested over real orders 2026-07-21.
**Phase 1 BUILT 2026-07-21** (branch `feat/artwork-check`) — see "Build status & rollout"
at the end for what shipped, the decisions taken on the open questions, and the go-live
checklist. Companion to `memory:artwork-sanity-check-productisation`. This is the
working spec for the build; update it as decisions change, the way
`docs/followup-automation-rollout.md` tracked the nudge project.

## What this is — and the failure it exists to catch

The dominant cause of a *wrong card reaching print* is not a fancy one. The customer types
their contact details into the online **artwork request form**; a designer then **re-types**
those details into the artwork by hand; a character in **any** field comes out wrong; and
**nobody can see it**. You cannot eyeball that a phone number, an email, a name spelling or an
address is "correct" — any plausible string passes visual QC — and the customer approves the
proof assuming you used exactly what they supplied. The typo survives approval and only surfaces
*after printing*. The same failure occurs when a customer **revises** a detail later in the
thread — sometimes silently — and the card still carries the old value. The
"approved-artwork-is-your-responsibility" disclaimer doesn't really save you there: a designer's
transcription typo (or a missed revision) is not something you can fairly pin on the customer.

The only thing that reliably catches this is comparing **what the customer actually supplied**
(which lives in the Help Scout thread / the request-form submission) against **what got typed
onto the card**. That comparison is done today, manually, in ChatGPT — outside the app, after
payment. This feature moves it *inside* the order workflow: an **advisory check that runs
between "To order" (Dropbox folder linked) and sending the job to the supplier / workshop.** It
gathers the customer's supplied details + the QR contents, reads the actual print artwork,
reconciles them, and shows the reviewer a short report *before* they hit send. It never sends
anything and never blocks on its own; a human always confirms.

The specification of *what to compare* is the installed `artwork-sanity-check` skill (an
8-field contact comparison: name, job title, company, address, tel, mob, website, email, plus
hunting the thread for later corrections). This feature is that skill, run automatically at the
right moment against the app's own data.

## Decisions locked in with Rob

- **The Help Scout thread is the PRIMARY reference.** The most frequent post-payment issue is a
  designer transcription typo of customer-supplied details, and only the thread (the form
  submission) holds the ground truth to catch it. Everything else is corroboration.
- **Also check the real Dropbox print files** (not only the approved proof) so it *additionally*
  catches errors introduced after approval, during print-prep. Important, but rarer than the
  transcription typo — so it's the secondary leg, not the headline.
- **Advisory, never auto-send.** A missed error prints wrong cards; the check flags for a human
  and the human always clicks send. Same stance as today's green-light/flag.
- **Running the check is MANDATORY; its verdict stays advisory.** A human still okays or dismisses
  each flag — a flagged verdict never hard-blocks the send. But an order **cannot be submitted to
  the workshop / supplier until the check has been run for it.** Enforced in the UI (`blockReason`)
  *and* server-side in `place-order`, behind an enforcement flag so it only bites once we trust it.
- **Include QR verification.** ~28% of ordered cards carry a QR; the decoded contents are already
  stored, so it's nearly free and a strong corroborator — better than the manual step, which
  skips QR entirely.
- **Skip technical checks** (DPI / CMYK / bleed / dimensions). Contact-content only.
- **Attachments matter.** Customers "reasonably frequently" supply details as a spreadsheet, PDF,
  or their own source artwork — and the request-form data itself may arrive as an attachment. So
  reading Help Scout attachments is in scope (see phasing / open questions).

## What it compares (three legs, in priority order)

- **Leg A — the card vs the customer's supplied details** *(PRIMARY — the transcription-typo
  catch)*. Card read from the **Dropbox print file** (hi-res, and the thing that actually
  prints). Supplied details from the **Help Scout thread** (the request-form submission + any
  later corrections). "Does every character on the card match what the customer gave us?"
- **Leg B — the card vs the QR** *(corroborator)*. Decoded QR (`qr_decoded_data` / vCard) vs the
  printed card face vs the supplied details. Catches QR-vs-face mismatches and gives a second
  authoritative source for the contact fields.
- **Leg C — the print file vs the approved proof** *(secondary — production drift)*. Did the
  print file diverge from what the customer signed off, after approval? Lower frequency than A;
  needs both images.

**Reference priority (learned from the backtest).** Trust, in order: (1) the **customer's
request-form submission / Help Scout thread** — the ground truth for what was *asked for*;
(2) the **vCard QR** — matched a real card across all six fields; (3) recipient **`names[]`**.
The `contacts` / company / order **record fields are WEAK** — they describe the *account*, not
the card (the orderer is frequently not the cardholder), and "company" is often a domain
shorthand. Use them only as loose corroboration, never as the thing the card must match.

## Reading the thread: chronological, latest-value-wins

The supplied details are **usually the first message** in the thread (the request-form
submission) — which is exactly why reading the *oldest* messages matters (see §1). But a
considerable share of jobs (**repeat customers** especially) have **no first-message form**: they
say "same as last time", reference a previous order, or supply details part-way through. So the
check must (a) find the supplied details wherever they are, and (b) for a repeat customer who
re-supplies nothing, reconcile against the **previous order / version** rather than report
"nothing supplied".

Then read the whole thread **oldest → newest and resolve each field to the customer's
LAST-supplied value.** Customers revise details later, sometimes **silently** (a new number or
spelling stated with no "correction" wording) — the first value is *not* gospel. This applies to
**any** retyped field — name spelling, title, company, email, phone, mobile, website, address —
not just phone numbers. Two failure modes fall out, and the check must flag both: (1) a designer
**mistyped** a supplied value; (2) the card matches the **original** request but the customer
**revised** it later and it was never picked up ("card shows a superseded value; revised to X on
&lt;date&gt;").

## The worked prototype + backtest (real orders)

**Prototype — Snap-on 403902 (matte black metal, vCard QR).** End-to-end, no shortcuts: pulled
the record + decoded QR, downloaded `03_Front.ai` / `01_Back.ai` from Dropbox, rendered to
3000px, reconciled. Read every character cleanly (incl. accented French) and found a **genuine
flag**: printed title *"Franchisé propriétaire"* ≠ QR title *"Franchisé autorisé Snap-on Tools
Canada"*. (The "mirror-reversed back logo" I noted first was a **false positive** — see the
metal cut-through rule below.)

**Backtest — 3 more orders (Nawsera, Nexusqs, Plak8).** Reading held up on **all** print files,
across both **PDF** (plastic jobs) and **`.ai`** (metal jobs), light and dark cards, down to a
postcode and a mobile number. One clean six-field match (Nexusqs, card ↔ vCard QR), two correct
all-clears. **The decisive finding: a naive field-equality check would have false-flagged 3 of
the 4 orders.** The value is almost entirely in the allow-list below.

## The "don't over-flag" rules (each earned from a real order)

- **Advisory, review-not-block.** Nothing here decides; a human confirms.
- **Compare the card to the RECIPIENT, never the account contact.** The person who *placed* the
  order is often not the person *on the card* (Plak8: Parissa Mobasher ordered, the card is
  Derrick Smith with his own email; Nawsera's contact is a personal gmail). Key every name/email
  check off `names[]` / `associated_name`, not `contacts.*`.
- **Cut-through backs are mirrored BY DESIGN — never flag.** When artwork (usually the logo) is
  cut *through* the material from the front, it is necessarily reversed on the back. This affects
  **every cut-through material — currently metal, acrylic, wood, and carbon fibre**. A mirrored
  logo/element on the back of a card in one of those materials is expected construction, not an
  error — gate this tolerance on the version's `material`.
- **The record's "company" is often a domain / shorthand** ("Nexusqs.co.uk", "Plak8.com") vs the
  card's real trading name ("Nexus Quantity Surveyors", "PlaK8 Security"). Don't flag; treat the
  QR ORG / printed name as authoritative.
- **Brand casing is intentional** (PLAK8 / PlaK8). Don't flag stylistic case in logos/brand names.
- **Card fields the record doesn't hold are "not supplied", not discrepancies** (title, address,
  phone — `contacts` has no phone column at all). Verify these against the *thread*, not the DB.
- **Skip the shared / front brand card** — no personal details to check.
- **Printed title vs QR title can legitimately differ** (Snap-on) — surface for a human, don't
  hard-fail.
- **One shared QR legitimately prints on every recipient's card** (Nawsera) — not a "missing
  per-person QR".
- **The print file / rendered artwork is the truth for what's ON the card.** Don't flag what you
  can't clearly see. **Never treat a gap as an error** — "couldn't read / supplied as an
  attachment / no thread match" is a `reference_gap`, not a discrepancy.
- **Read chronologically; the latest supplied value wins** (see "Reading the thread" above) —
  this covers explicit corrections ("noticed", "typo", "should be", "change") *and* silent later
  revisions, and it flags a card that still carries a now-superseded value.

## Where it lives in the workflow

`OrderReviewPage` at **`/orders/:id/place`** already sits precisely between "folder linked" and
the place-order Confirm. It already loads the approved artwork, the order spec, and the
material/version. Reuse two existing patterns:

- **The advisory card** — `preview.handoff_validation` renders as the amber "Stock Control
  hand-off checks" card (`OrderReviewPage.tsx:339-343`, ~593-617): informational,
  `{ problems[], warnings[] }`, **deliberately not part of `blockReason`**. The artwork report
  renders as a sibling card in exactly this shape.
- **The block gate** — `blockReason` / `canConfirm` (`OrderReviewPage.tsx:300-337`) disables
  Confirm. Add **one clause**: when enforcement is on and the check hasn't been run for this order
  (`orders.artwork_checked_at IS NULL`), block with *"Run the artwork check before placing this
  order."* This makes **running** mandatory while the **verdict** stays advisory — a flagged
  result does not block; the human okays it. (Stricter later option: a flagged verdict soft-blocks
  behind an "I've reviewed the flags" checkbox, like the existing `oldJobCancelled` attestation.)

The check runs as its **own edge function** invoked from the review page (not folded into the
`place-order` preview) because it's a heavier multimodal call — it shouldn't slow or risk the
send path. The result is cached on the order so re-opening the page is instant.

## Data sources & how to fetch each

### 1. The customer's supplied details — Help Scout thread (PRIMARY, service-side API)
Reuse `_shared/helpscout.ts` `fetchConversationWithThreads`
(`GET /v2/conversations/{id}?embed=threads`; OAuth client-credentials via `HELPSCOUT_APP_ID` /
`HELPSCOUT_APP_SECRET`). This is a **REST API call the app already makes in production** — the
MCP connector is irrelevant to the build. **Three required changes vs today:**
- **Paginate.** The current call reads only the first ~25-thread page, newest-first — long
  threads silently drop the *oldest* messages, which is exactly where the request-form submission
  usually is. Follow `_links.next`.
- **Use raw `thread.body`**, not the lossy human-preview cleaner in
  `fetch-helpscout-conversation-context` (it strips signatures/quotes and could remove the very
  detail block the check needs).
- **Read attachments** (see §5) — the request-form data may arrive as an attachment, not inline.

⚠ **The request-form submission is typically the FIRST message** in the thread — so paginating to
the *oldest* end is doubly critical. But a considerable share of jobs (repeat customers) have no
first-message form; the check must handle that (see "Reading the thread") by reconciling against
the previous order rather than reporting nothing supplied. (Open question #2.)

### 2. QR contents (Supabase, already structured — no vision needed)
`proof_version_images` where `is_qr_code`: `qr_decoded_data` (verbatim payload, CHECK-guaranteed
non-null on QR rows), `qr_kind` (`vcard` / `url` — the only live kinds), `qr_vcard_slug`. For
`hosted_vcard` use `proof_name_approvals.qr_snapshot` (000194) instead of `qr_decoded_data`
(which is only the short URL) — though no fulfilled order uses `hosted_vcard` today.

### 3. The card being printed — Dropbox print file (hi-res)
`orders.dropbox_folder_url` (100% present on fulfilled orders) → resolve → list the folder → the
print files. **File type depends on the job:** metal jobs are native **`.ai`**
(`NN_Front.ai` / `NN_Back.ai`); plastic / full-colour jobs export as **PDF**
(`NN_Front.pdf`, per-recipient `NN_<Name>.pdf`). Both render identically well. The proof JPEGs
alongside are **not** a reliable substitute — observed to lag the print file by days; always
read the print file. Dropbox access from the function: reuse the existing integration
(`dropbox-folder`, `clone-order-folder` edge functions) to list and fetch bytes.

**The render decision.** The `.ai` are valid `%PDF-1.6`. **Recommended: pass each print file to
the model as a PDF document block** (relabel `media_type: application/pdf`; 1 page, <1 MB — well
inside limits). No renderer needed. **Must be confirmed** the API accepts the Illustrator-
flavoured PDF (open question #1 — the prototype rendered locally with `sips` instead).
**Fallback:** rasterise with a WASM PDF renderer (`mupdf-wasm` / `pdfium`) inside the Deno
function at ≥300 dpi — the backtest proved 3000px is ample even for a postcode. (Neither
`poppler` nor `sips` exists in an edge function, hence the PDF-block-or-WASM route.)

### 4. Recipient names + weak corroboration (Supabase, service role)
Current version via `proof_versions where is_current` → `names[]` / per-image `associated_name`
(the strong keys). `contacts.full_name` / `email` and `companies.name` are the **weak** account
fields — corroborate only.

### 5. Attachments (Help Scout)
Not fetched anywhere today. Add: embed attachment metadata, then
`GET /v2/conversations/{id}/attachments/{attachmentId}/data` (base64). Route by type: image/PDF →
content block; **xlsx/csv → parse to text** (SheetJS / CSV parse); `.ai`/`.eps` → the same PDF
path as print files when PDF-compatible. Priority depends on where the request-form data lands
(§1 / open question #2): if it's an attachment, this moves into Phase 1.

## The AI call (reuse the aiDrafts pattern)

Reuse `supabase/functions/_shared/aiDrafts/`: Anthropic Messages API via raw `fetch`
(`anthropic.ts`), model `claude-opus-4-8`, `ANTHROPIC_API_KEY`, `postWithRetry` (429/5xx
backoff), structured output via `output_config` json_schema, prompt caching
(`cache_control: ephemeral`) on the stable rules prefix, and the service-role auth gate from
`ai-draft/index.ts` (`timingSafeEqual` against the service key or a `role: service_role` JWT).

**The one net-new capability:** the aiDrafts calls are *text-only* (`content` is a string). This
check needs **multimodal** — a `content` array mixing `{type:'text'}` (thread + QR + names),
`{type:'document', source:{type:'base64', media_type:'application/pdf',…}}` (print files), and
`{type:'image',…}` (approved proof, for Leg C). Small, localised change to `structuredCall`.

System prompt = the rules above (cached). User content = supplied details (thread text, QR
payloads, recipient names) + the artwork (print-file PDFs, approved-proof images), each clearly
labelled per card / person.

## The report (structured output schema)

```jsonc
{
  "verdict": "clear" | "flagged" | "error",
  "summary": "one line, issues-first",
  "cards": [
    { "label": "Derrick Smith — front/back",
      "findings": [
        { "field": "email",
          "supplied": "derrick@plak8.com (request form)",
          "printed": "derick@plak8.com",
          "status": "match" | "flag" | "not_supplied",
          "note": "printed email drops an 'r' vs what the customer supplied" }
      ] }
  ],
  "corrections": [ { "quote": "...should be Jon not John", "resolved": true|false } ],
  "notes": [ "metal cut-through back — logo mirrored as expected" ],
  "reference_gaps": [ "no request-form submission found in the thread" ],
  "model": "claude-opus-4-8",
  "usage": { "...": "tokens" }
}
```

Rendered on the review card: `✅ All clear` or `⚠️ N things to check`, each finding showing
*supplied vs printed* so the reviewer adjudicates in seconds.

## Schema changes

Minimal — mirror the `handoff_payload` pattern (store the latest report on the order):

- `proofs.orders.artwork_check jsonb` — the latest report (shape above).
- `proofs.orders.artwork_checked_at timestamptz`.
- `proofs.orders.artwork_check_verdict text` — `clear | flagged | error`, for filtering / a chip.
- Settings (not order columns): `settings.artwork_check_mode` (`off | shadow | live`) and
  `settings.artwork_check_required boolean` — the rollout gate and the mandatory-run enforcement.

`orders` already carries `authenticated` CRUD (000176) and service-role writes (used by
`place-order` / `stripe-webhook`), so a new column needs **no grant work**. **Do not pick a
migration number from any doc** — run `ls supabase/migrations/0003*` and take the next free one;
apply via MCP `apply_migration` (Rob gates prod), schema-qualified `proofs.`. (If we later want
re-run history, promote to a `proofs.artwork_checks` table with the full explicit grant matrix —
the `proofs` schema has no default privileges.)

## The edge function

New `supabase/functions/artwork-check/` (+ shared logic in `_shared/artworkCheck/` so it's
unit-testable like `_shared/aiDrafts/` and `_shared/nudgeDecision.ts`):

1. Service-role / JWT auth gate (copy `ai-draft/index.ts`).
2. Input `{ order_id }`. Load order + proof + current version + recipient names + QR rows.
3. Gather supplied details: Help Scout thread (paginated, raw bodies, + attachments).
4. Gather artwork: Dropbox print-file bytes (+ approved-proof signed URLs for Leg C).
5. One multimodal `structuredCall` → report JSON.
6. Persist to `orders.artwork_check{,_at,_verdict}`.
7. Return the report to the page.

Deploy with `--project-ref bjvinrzbdrwebylkmbwy`; **preserve** the function's `verify_jwt`
(don't blanket-set false); byte-verify after deploy (`memory:supabase-edge-deploy`).

**The mandatory-run gate is enforced in `place-order` (mode `confirm`), not here:** when
`settings.artwork_check_required`, it rejects with `artwork_check_required` if
`orders.artwork_checked_at IS NULL`, so a direct API call can't bypass the UI gate — mirroring how
`place-order` already re-checks the edited hand-off message server-side.

## The UI (OrderReviewPage)

- **Auto-run** the check when the review page loads — so the happy path needs no extra click and
  the mandatory-run gate is satisfied without friction — with a spinner; plus a **"Re-run"**
  affordance (artwork can change between visits).
- Result as a `handoff_validation`-style advisory card: verdict headline + per-card findings
  (supplied vs printed) + notes + reference-gaps. Green when clear.
- **Confirm stays disabled until a check has completed** for the order (*"Run the artwork check
  first"*). A **flagged** verdict does *not* disable Confirm — the human reviews the flags and
  proceeds. If a run **errors** (Help Scout down, render failed), show the reason and let them
  re-run; an errored run still satisfies the "has been run" gate so a transient outage can't
  strand an order (open q — or require a clean run if Rob prefers stricter).
- Optionally a verdict chip on the To-order card in `OrdersPage.tsx`.

## Rollout (shadow-first, the house discipline)

Mirror the `ai-draft` backtest and `place-order` `loadHandoffMode` shadow pattern. Behind a
`settings.artwork_check_mode` (`off | shadow | live`) flag: in `shadow`, the function runs and
stores the report but the page shows nothing. Run it over ~25–30 real fulfilled orders; Rob
reviews the reports and we tune the prompt + allow-list until the signal-to-noise is right.
Nothing reaches staff until proven. Then flip to `live` and the card appears. A separate
`settings.artwork_check_required` boolean turns on the **mandatory-run gate** (Confirm blocked, in
the UI *and* in `place-order`, until the check has run) — leave it off during the initial `live`
window so staff get used to the card, then switch it on so **no order reaches the workshop /
supplier without a check having run**.

## Phasing

- **Phase 1 (the high-value core): Leg A + Leg B.** Help Scout thread (paginated, raw bodies)
  → the Dropbox print file, plus QR corroboration and recipient-name keying. This is the
  transcription-typo catch — the dominant failure — at full print fidelity. Shadow → advisory.
- **Phase 2: attachments + Leg C.** Read Help Scout attachments (the request form may live here —
  may need to pull forward into Phase 1); add the approved-proof → print-file drift check.
- **Phase 3: tuning** the allow-list from real use; optional soft-block; a "checked ✓" stamp;
  maybe auto-run on payment with a dashboard flag.

## Trust & safety

- Advisory only; a human always confirms the send. Internal-only — the report never touches a
  customer-facing surface (`public_*` views / anon RPCs stay untouched).
- Cost/latency negligible at ~26 orders/week.
- Reads customer PII (thread, contact details) — service-role, edge-side, stored on the internal
  `orders` row only.

## Open questions / to confirm

1. **Does the Anthropic API accept an Illustrator `.ai` relabelled as `application/pdf` as a
   document block?** If yes, no renderer needed. If no, add the WASM rasteriser. One quick test
   settles it and picks the render route.
2. **Repeat-customer / no-first-message jobs.** The form is *typically* the first message, but a
   considerable share (repeat customers) re-supply nothing — "same as last time", a reference to a
   prior order, or details mid-thread. Decide how the check reconciles these (against the previous
   order / version) vs reporting a `reference_gap`. Also confirm whether any form data arrives as
   an attachment (→ pulls attachment-reading into Phase 1).
3. **Allow-list** — the batch + Rob seeded it (see the rules above); keep tuning in shadow mode.
4. **Errored / stale runs & the mandatory gate.** Decided: auto-run on load, and *running* is
   mandatory (verdict advisory). Confirm: does an **errored** run satisfy the gate (recommended —
   non-stranding) or must it be a clean run? Should the gate require a run against the **current**
   artwork (force a re-run if the print file changed) vs ever-run? And should a flagged verdict
   ever soft-block (stricter, later)?
5. **Storage shape** — a jsonb column (recommended) vs a history table.

## Key files (pointers for the build session)

- Insertion point: `src/pages/OrderReviewPage.tsx` (`handoff_validation` card ~339-343 / 593-617;
  `blockReason`/`canConfirm` 300-337), `src/pages/OrdersPage.tsx` (To-order card).
- Send action being gated: `supabase/functions/place-order/` (mode `confirm`).
- AI pattern to copy: `supabase/functions/_shared/aiDrafts/` (`anthropic.ts`, `pipeline.ts`),
  `supabase/functions/ai-draft/index.ts` (auth gate, mode gate).
- Help Scout (primary reference): `supabase/functions/_shared/helpscout.ts`
  (`fetchConversationWithThreads`), `supabase/functions/fetch-helpscout-conversation-context/`.
- Artwork: Dropbox `supabase/functions/dropbox-folder/`; `src/lib/approvedArtwork.ts` +
  `supabase/functions/customer-proof-images/` (service-role signed URLs, for Leg C).
- QR: `src/lib/qrCodes.ts`; schema `proof_version_images` (QR cols), `proof_name_approvals`
  (`qr_snapshot`).
- Shadow-gate precedent: `place-order/index.ts` `loadHandoffMode` / `runHandoffValidation`
  (~1085-1123).
- Check-rule source of truth: the installed `artwork-sanity-check` skill.

## Build status & rollout (2026-07-21, Phase 1)

**What shipped** (branch `feat/artwork-check`):

- **Migration `000336_artwork_check.sql`** — `orders.artwork_check` jsonb +
  `artwork_checked_at` + `artwork_check_verdict` (CHECK clear|flagged|error), and the two
  settings gates: `artwork_check_mode` (off|shadow|live, default **off**) +
  `artwork_check_required` (default false). ⚠ **Not yet applied to live.**
- **`supabase/functions/_shared/artworkCheck/`** — the unit-testable core: `types.ts`,
  `schema.ts` (structured-output json_schema), `prompts.ts` (system prompt carrying the
  full allow-list; tune THIS from shadow reports), `printFiles.ts` (.pdf/.ai selection +
  caps + `%PDF` sniff + the cut-through material set), `threadText.ts` (chronological
  flatten, raw bodies via `normaliseBody`, attachment names surfaced, oldest+newest kept
  on overflow), `anthropic.ts` (the multimodal structuredCall — text + PDF document
  blocks; model `claude-opus-4-8`, env-overridable `ARTWORK_CHECK_MODEL`), `report.ts`
  (verdict derived in CODE: any flag finding or unresolved correction → flagged).
  Tests: `pnpm test:artwork-check` (64 checks).
- **`supabase/functions/artwork-check/`** — the edge function: designer-JWT or
  service-role auth, mode gate, cached-report fast path (`{ force: true }` re-runs),
  full-thread Help Scout read (new paginated `fetchAllConversationThreads` in
  `_shared/helpscout.ts`), Dropbox print-file fetch, one multimodal call, persists the
  report on the order. A Help Scout outage degrades to a reference gap (QR + roster legs
  still run); Dropbox/AI failures persist a verdict-'error' report. ⚠ **Not yet
  deployed** (deploy WITHOUT `--no-verify-jwt` — this function wants verify_jwt true).
- **`place-order`** — mode `confirm` now 409s `artwork_check_required` when the gate is
  on (live + required) and `orders.artwork_checked_at` is NULL. Column read is a separate
  query, so the function stays deployable before the migration. ⚠ **Redeploy needed.**
- **`OrderReviewPage`** — auto-runs the check on load (satisfies the mandatory-run gate
  with zero clicks), renders the advisory card only when the response says mode=live
  (off/shadow/undeployed → nothing), Re-run affordance, flags shown supplied-vs-printed
  with a collapsed full comparison table, `blockReason` clause for the run gate. A failed
  re-run keeps the previous report (never empties good state).

**Decisions taken on the open questions** (revisit in shadow if wrong):

1. *Illustrator-PDF acceptance* — **SETTLED 2026-07-21, first live run**: the API accepts
   `.ai` files relabelled `application/pdf` and genuinely reads them (order 403910's
   `01Front.ai`/`01Back.ai` — the model read every printed field and even spotted an
   undecoded QR printed on the back). No rasteriser needed; the `%PDF` sniff stays as the
   guard against ancient non-PDF `.ai` files.
2. *Repeat customers* — Phase 1 reports honest `reference_gaps` ("details not re-confirmed
   in this thread") rather than reconciling against a previous order; attachments are
   surfaced by filename as gaps, not read (Phase 2).
3. *Allow-list* — encoded in `prompts.ts` verbatim from this spec; tune there.
4. *Errored runs* — an errored run DOES satisfy the mandatory-run gate (non-stranding),
   and the gate is ever-run (no staleness check on the print files) — the Re-run button
   covers artwork changed between visits. A flagged verdict never blocks.
5. *Storage* — jsonb column on `orders` (no history table).

**Deploy order** (each step safe before the next): ① apply 000336 via MCP → ② deploy
`artwork-check` + redeploy `place-order` → ③ merge/deploy the frontend. The frontend is
tolerant of ①/② missing (invoke fails → card hidden), and both functions are tolerant of
① missing (settings read errors → mode off), but the artwork-check function can only
actually RUN once ① is applied.

**Rollout checklist:**

- [x] Apply migration 000336 — **done 2026-07-21** (MCP `apply_migration`, name
      `artwork_check`; all 5 columns verified with defaults off/false; advisors clean).
- [x] `ANTHROPIC_API_KEY` Supabase secret — **verified present** (shared with ai-draft).
- [x] Deploy `artwork-check` (v1, verify_jwt TRUE) + redeploy `place-order` (v29,
      verify_jwt preserved TRUE) — **done 2026-07-21**, all 13 bundle files byte-verified
      identical to the repo via `supabase functions download` + `cmp`.
- [x] Flip `artwork_check_mode` → `shadow` — **done 2026-07-21**. First live run (order
      403910 The Boat Shack, metal `.ai` reorder): HTTP 200 in ~45s, verdict `flagged`
      (an undecoded QR printed on the back — worth a human eyeball), correction
      detection worked (the mid-thread "add work phone" request verified as landed on
      the card), reorder carried-over details honestly reported as reference gaps, and
      the no-cutout construction correctly excused the unmirrored back. Report persisted
      to `orders.artwork_check` with usage + a 3.6k-token prompt-cache write.
- [x] Seed the tuning set — **done 2026-07-21**: batch-ran the last 24 fulfilled orders
      (3 concurrent, ~4½ min wall, ≈$2 of API total). **14 clear / 10 flagged / 0
      errors.** Genuine catches: **403898 Everest** (Christine's email misses the 't' in
      'health' vs every other card + the website — customer-typed, staff queried twice,
      never confirmed, printed anyway; the model read all 10 per-person PDFs after the
      cap fix below), **403894 Hurst** (the `04.ai` print file's gold-letter treatment
      contradicts the approved arrangement while `04.pdf` in the same folder is correct
      — a real print-file-drift catch), **403899 Plak8** (customer's explicit 15 Jul
      phone re-spacing never picked up), **403892 Roundtable** ("ROUNDTABLE" one word vs
      the customer's later two-word restatement), and **403902/403901 Snap-on**
      (reproduces the manual prototype's title finding exactly). Coverage fix shipped
      same day: print-file count cap 8 → 16 (403898 had 10 per-person cards; two were
      skipped at 8) — deployed as v2, byte-verified, Everest force-re-run to full
      coverage.
- [x] Tune `prompts.ts` from the batch — **done 2026-07-21** (commit 619dad9, function
      v3, byte-verified). Four rules added, each from a batch order: signatures are
      corroboration not requests (403903); the customer's own logo wording is
      authoritative, not just its casing (403904); unverifiable revisions (unread
      attachments, quantity/roster) are reference_gaps, never resolved=false (403897);
      digit-identical phone regrouping matches unless explicitly requested. Plus the
      undecoded-QR stance made explicit: visible QR with no stored payload = one flag
      per code — the deliberate exception to gaps-are-not-flags. **Validation re-runs,
      5/5 as intended**: 403903, 403904, 403897 all flipped to clear (each summary
      showing the new rule applied, not silence); 403898 Everest and 403899 Plak8 kept
      their genuine flags — the digit-identical rule correctly did NOT excuse Plak8's
      explicitly-requested regrouping. Post-tuning tally over the 24-order set:
      **17 clear / 7 flagged**, and every remaining flag is a genuine catch, the
      Snap-on advisory title pair, or the deliberate QR policy. Phase 2's attachment
      reading would dissolve several remaining reference gaps (403884/403888/403897
      key their ground truth in spreadsheets / PDFs / Drive links).
      Ops note: long curl calls to the function need HTTP/2 (HTTP/1.1 dies at the
      gateway's 60s idle timeout; even HTTP/2 drops the response ~5 min in while the
      run completes and persists server-side — read the row, not the response, for
      batch work).
- [x] Flip `artwork_check_mode` → `live` — **done 2026-07-21** (Rob's call after
      reviewing the batch + tuning). The advisory card now appears on the Place-order
      review screen. Same day, the two switches got their admin home (PR #522): a new
      **Admin → Settings → Artwork check** section with the Off/Shadow/Live picker and
      the confirm-guarded "Require a check before placing" toggle (inert unless Live),
      registered in the jump nav + admin feature search. Flag flips no longer need SQL.
- [ ] After a settling-in window: flip `artwork_check_required` → true (now a toggle on
      Admin → Settings → Artwork check; enforced in the UI and in place-order).

**Phase 2a — attachment reading: SHIPPED 2026-07-21** (PR #523; function v4, then v5 the
same evening — see below; `pnpm test:artwork-check` 93 checks). Customer-authored Help
Scout attachments are downloaded and read as supplied reference material: xlsx/xls/csv/
tsv/txt parsed to text (SheetJS via `npm:` on the edge runtime — proven live on Fishies'
`Book1.xlsx`), PDFs + PDF-compatible `.ai` as document blocks, photos as image blocks;
each labelled filename+date; latest-wins across messages and attachments alike.
Deliberate boundaries: STAFF attachments are never read (our own proof exports — reading
them would verify the card against itself); unreadable ≠ absent (every pass-over recorded
by name, stays an honest gap); identical files riding several messages read once;
attachments share the request byte budget with the print files (spreadsheets first,
oldest first). **Validation on the gap orders:** 403897 gap→verified roster (and an
honest "only 1 of 145 named fronts present in the folder" observation), 403884
gap→order-form-verified name, and 403888 flipped clear→flagged with a NEW catch (the
front print omits "CHRISTOPHER HOOPER" / "DIRECTOR" that appear on the customer's own
supplied design — for human adjudication). **The regression guard earned its keep:**
Everest 403898 initially dropped its email flag once the model saw the customer restate
the typo'd address in an attachment — fixed same evening (v5) with failure mode (3):
a supplied value that CONTRADICTS the customer's own other materials flags even when the
card matches the request as typed; re-run confirmed flagged again with the "matches as
typed, but…" note. Still unread: `.eml`/`.eps` attachments, and links out to Drive/
Dropbox in thread text (deliberately out of scope).

**Auto-run: SHIPPED 2026-07-21** (migration 000337, applied via MCP). The check fires
automatically the moment an order's Dropbox folder is linked — NOT at payment, which
sounds right but isn't (at payment there's no folder yet, so a payment-time run could
only record a "no folder linked" error). A DB trigger on `proofs.orders`
(`notify_artwork_check_on_folder_link`, the 000320 push-trigger idiom: pg_net POST
authed with the `proofs_send_nudges_key` vault secret) fires on first-link AND re-link
with `force:true`, so a changed folder refreshes any stale report — which also covers
the folder-changed case of the staleness-guard item. Mode-gated in the trigger itself
(off = zero network chatter); wrapped in an exception guard so an order write can never
fail on the check's plumbing; the review page's on-load run stays as the backstop.
Verified live end-to-end on order 403893: trigger → pg_net (the 5s client timeout is
expected — the function continues after disconnect) → fresh report persisted 17 seconds
later. ⚠ Incident during testing, resolved: a badly-written test UPDATE briefly nulled
403893's `dropbox_folder_url` (~10 min); recovered byte-identical from the folder's own
Dropbox shared-link record and verified intact — no flow read it in the window
(fulfilled order). Lesson recorded: capture-then-restore values as literals, never via
self-referencing subqueries.

**Leg C + the Orders-page chip/archive: SHIPPED 2026-07-21** (PR #524; function v6, then
v7 the same evening — see below; `pnpm test:artwork-check` 104 checks). **Leg C:** the
check downloads the version's approved proof images (gallery-ordered, byte budget shared
with prints + attachments) and compares the print files against them for post-approval
drift — contact text, names, titles and explicitly-agreed treatments must not diverge;
rendering artefacts, proof chrome, crop/bleed and cut-through mirroring tolerated. The
report body moved into the shared `src/components/ArtworkCheckReportView.tsx` (review
card + archive modal render from one component). **Orders page:** a verdict chip
(green ✓ / amber ⚠) beside the To-order readiness ticks and on Recently-ordered rows,
gated on mode=live, clicking through to the stored report in a modal — the in-app
archive; the report jsonb is fetched lazily per click. **Validation:** Hurst 403894 now
flags ON the approved-proof comparison ("04.ai gilds only the 'R'… but the approved
proof (and 04.pdf) gilds both whole words") — the drift catch is grounded, not lucky;
For The Boys 403900 initially flipped flagged on a MAY instruction the customer
superseded in July — fixed same evening (v7) with the superseded-instruction rule
(corrections[] tracks the LATEST wish per topic; an out-of-date instruction is never an
open correction) and re-verified clear, its summary now positively citing the approved
silver-foil revision.

**Per-flag investigation ("Investigate the history"): SHIPPED 2026-07-21** (PR #526;
function v8, byte-verified; `pnpm test:artwork-check` 117 checks). Rob's design: the
primary check says WHAT disagrees; a button on each flag answers WHEN it arose and
WHOSE it is — designer-triggered only, never automatic, so the cost lands exactly where
a human wants the circumstances. Walks the flagged card's artwork across every proof
round (designers rarely write change notes, so the artwork is the source of truth),
dates each round against the thread's dated instructions, and returns a merged
timeline + plain-English conclusion + fault lean (`ours_transcription` /
`ours_missed_revision` / `customer_origin` / `undetermined`). Cached in
`artwork_check.investigations` keyed card::field (paid for once; a force re-run of the
main check deliberately discards them). Both surfaces render it via the shared report
view. **Shadow validation, 2/2 as predicted:** Everest 403898 email →
**customer_origin** (timeline caught the as-typed supply on 14 Jul, both internal
queries, and every round v6–v8 reproducing it faithfully); Plak8 403899 tel →
**ours_missed_revision** (v1–v2 matched the instruction current at the time; the
explicit 15 Jul re-grouping landed after v2; v3–v5 all post-date it and still show the
old grouping). The dates-decide-everything rule held: pre-revision rounds innocent,
post-revision rounds not.

**Red ✗ defect tier: SHIPPED 2026-07-21** (PR #528; migration 000338 applied — widens
the verdict CHECK to clear|flagged|defect|error; function v9, byte-verified;
`pnpm test:artwork-check` 124 checks). Findings + corrections carry a model-graded
severity against the "would we bet a reprint on it" bar — defect reserved for exactly
three categories: (1) functionally broken value, (2) explicit written instruction not
carried out, (3) print file contradicts the approved proof. Choose-review-when-torn is
in the prompt, and the legitimate-difference shapes are named never-red. Any
defect-grade flag ⇒ verdict `defect`: red ✗ Orders-page chip, rose review card with
`❌ N items look wrong`, defects sorted first and ✗-marked. Red stays ADVISORY — the
gate still only requires a run. **Re-grade validation, exactly the predicted 3/4
split:** Everest 403898 (broken email, cat 1), Plak8 403899 (ignored instruction,
cat 2), Hurst 403894 (drift, cat 3) → **defect**; Roundtable 403892, Snap-on
403901/403902 (titles, correctly "possibly intentional"), Boat Shack 403910 → review.
Notably the model graded Boat Shack's boat-shack.com-vs-boatshackutah.com domain
difference review, not defect — the right restraint on a genuinely arguable case. The
two investigations (discarded by the re-runs) were re-run and reproduced their fault
attributions exactly: Everest → customer_origin, Plak8 → ours_missed_revision.

**QR decode from approved artwork: SHIPPED 2026-07-21** (PR #529; function v10,
byte-verified; `pnpm test:artwork-check` 134 checks). First live-use finding: Top
Hampers 403912 flagged "QR present, nothing on file to verify" on both cards even though
they scan fine — because the check only ever compared print files against QR payloads
REGISTERED on the proof, and this proof's QR was registered on v1 but not carried onto
the current version. Fix: reuse the version-form scanner's engine (`zxing-wasm`, same
3.1.2 pin + tryHarder/downscale/invert recipe) server-side over the approved-proof JPEGs
the check already downloads for Leg C (`qrDecode.ts`). Decoded payloads join the
DB-registered ones as a second authoritative source; the no-payload flag fires only when
a QR is printed AND neither source yields it; a disagreement between sources flags (a
free print-vs-registered cross-check). **The Deno-runtime wasm question — the one thing
unprovable until deployed — is SETTLED: it loads and decodes.** Re-run of 403912:
`qr_decoded_from_artwork = 1`, QR flags 0, verdict **flagged → clear**. Boundaries: raster
only (print files are vector; verifying the print file's own QR needs a rasteriser,
parked); strictly fail-safe (library's default fetches the pinned wasm from jsdelivr; any
failure returns [] and behaves as today; latched off per-instance). ⚠ Note from the same
re-run: the model also stopped flagging Top Hampers' supplied-logo wordmark ("TOP
GIFTING") vs the printed "TOP HAMPERS" — model variance on a borderline case under the
logo-wording-authoritative rule (000304-era Box Sash tuning), unrelated to the QR change;
revisit if that difference should reliably surface for review.

**Dedicated Admin tab + selectable model: SHIPPED 2026-07-21** (PR #532; migration 000339
applied; function v11, byte-verified). The controls moved off Admin → Settings to their
own **Admin → Artwork check** tab (Messaging & automation group, beside AI drafts):
Off/Shadow/Live mode, the confirm-guarded run gate, and a new Claude-model picker. The
old `/admin/settings#artwork-check` deep link redirects; `Toggle`/`RadioGroup` moved into
the shared `settingsControls`. **Model** is `settings.artwork_check_model` (null =
default), read by the function in `loadCheckSettings` and threaded through the main call,
the investigation call, and the stored report's `model` field — precedence
setting > env `ARTWORK_CHECK_MODEL` > `claude-opus-4-8`, effective next run, no redeploy.
Curated dropdown (Opus 4.8 recommended/validated; Opus 5; Sonnet 5; Fable 5) so a typo
can't reach the API; a SQL-set value outside the list is preserved. **Opus 5 added
2026-07-25** — the compiled default stays Opus 4.8 (the tuned/validated model), so the
option is there to A/B against, not a silent switch. Note the `ADAPTIVE_THINKING_MODELS`
gate in `_shared/artworkCheck/anthropic.ts` matches on model id: a family it doesn't match
runs *without* adaptive thinking, with no error — add new ids there and to the dropdown
together. Live state at ship:
mode=live, **required=true** (Rob flipped the gate on during settling-in — now visible on
the tab), model=null (default).

**Pre-send proof check: BUILT 2026-07-23** (migration 000343; branch
`feat/pre-send-proof-check`). The designer-triggered sibling of the order check, run at
the FIRST gate: a proof version's own images vs the Help Scout thread + attachments +
QR contents, BEFORE the customer sees the proof — the "complex change requests split
across several emails" catch, while a fix is still free. Rob's ask 2026-07-23; the
standalone-tools-tab and project-Dropbox-source options were analysed and rejected
(the check is project-anchored, and the proof JPEG is what the customer sees — the
print-drift legs belong to the order gate). Shape: **no Dropbox at all** — the card
side is the version's `proof-images` storage files (picked by the Leg C gallery logic,
QR-scanned by `qrDecode.ts` on the way, 18 MB pool before attachments); no approved-
proof leg and no defect category 3 (nothing is approved yet). Same edge function
(`artwork-check` takes `proof_version_id` XOR `order_id`; shared target resolution,
investigation, cached fast path, persistence — reports land on
`proof_versions.artwork_check/checked_at/verdict`, same column trio as orders). Its own
prompt (`PROOF_SYSTEM_PROMPT` — a separate literal so the validated order prompt stays
byte-stable; adds the walk-every-change-request rule and the redesign-is-not-a-flag
rule, keeps latest-wins/severity/allow-list; guarded both ways by tests, 173 checks).
Gate: `settings.proof_check_enabled` boolean (default OFF — deliberately not the
off/shadow/live enum; a manual button is offered or it isn't), read as a SEPARATE
settings query so a pre-000343 DB can't null the order check's mode read. UI: a
Proof-check panel above the Versions panel on `/proofs/:id` (idle row + Run check →
spinner → the shared `ArtworkCheckReportView` with heading "Proof check", Re-check,
and per-flag Investigate); Admin → Artwork check gains the "Pre-send proof check —
before the customer" toggle card, with the page copy reframed around the two gates.
Deliberately NO auto-run trigger — versions are created far more often than orders;
the button puts the cost where the judgement is (background auto-run on version save
is the possible later upgrade once real use proves worth it). ⚠ Deploy order:
migration FIRST (ProofDetailPage's version select and the function's version-target
select both name the new columns), then the function, then the frontend merge.

**Follow-up same day (Rob): the check surfaced IN the save flow.** The proof detail
page sits outside the designers' typical workflow, so the check now also lives in
`VersionPreviewGate` — the forced post-save preview both New- and Edit-version pages
already route through. A "Run proof check" chip sits right-aligned in the gate's
checklist row (visually apart from the required review chips — it never gates the
confirm): idle → spinner while the run continues server-side (confirming mid-run
loses nothing; the report persists and shows on the project page) → a verdict chip
("❌ Proof check · 2 items look wrong") that opens the full report in a capped
scrollable modal (Re-check + per-flag Investigate inside). The run/investigate/gate
state moved into the shared `src/lib/useProofCheck.ts` hook — ProofDetailPage and
the gate both consume it, so the function contract has ONE client. The gate always
runs `force: true` (on the edit flow a stored report predates the just-saved edit).
Frontend-only — no migration or function change. Harness rig: `?path=/preview-gate`.

**Report readability v2 (Rob's review of live reports, 2026-07-24):** the report now
reads verdict → summary → **the side-by-side table** (open, promoted — "second most
valuable thing after the headline"): a real grid per card, Field | On the card |
Supplied, with flagged rows tinted rose/amber so the table carries the severity
signal alone (the old collapsed `<details>` is gone, and matches now show their
supplied value too). The detailed flag blocks follow, then **Couldn't check as an
amber-accented block** — inside a green all-clear card the unverified bits no longer
read as verified (the VERDICT stays green deliberately: nearly every report has some
gap, so demoting the traffic light would make green meaningless). **Good to know**
drops to last, and both prompts' notes[] rules were sharpened (at most three, plain
English a non-specialist reads at a glance, never pipeline narration, never restating
the table/gaps; gaps one plain sentence each) — prompt changes affect NEW runs only.
Layout is the shared component, so it applies to stored reports instantly on every
surface. Function redeploy required for the prompt half. **Same-day follow-up (the
Daniel Barrera all-clear):** two more output-discipline rules in BOTH prompts —
reference_gaps[] is only for material that EXISTS but couldn't be verified ("no QR
codes and none requested" is not a gap; an empty gaps list is the normal state of a
fully-checked job, so the amber block stops decorating clean reports), and a field
absent from BOTH the card and every reference earns no table row (nothing-vs-nothing
padding), while requested absence ("leave my address off") stays a recorded match —
verified absence is a real check.

**Report lifecycle (Rob's question, same day):** the rule is *"a report always
belongs to exactly the artwork it was run on; every checked version keeps its report
forever; anything unchecked plainly says so."* Three mechanics deliver it: (1) a new
version is born with empty check columns (the insert never copies them), so v3 can
never wear v2's verdict — the panel and gate read idle; (2) **an edit-save clears
the version's stored report** (EditVersionPage nulls the three columns) so a report
can never describe artwork it wasn't run against — the designer re-runs from the
gate they're already passing through; (3) **every checked version keeps its report**,
now visible via a verdict pill (✅/⚠️/❌ "Proof check") on its Versions-list row that
opens the stored report read-only in the capped modal — the per-version archive
(Re-check + the history investigation stay on the CURRENT version's panel; a
superseded version's report is a frozen record). A fresh panel run also mirrors its
report onto the row so the pill appears without a reload.

**Deferred to Phase 3:** a print-file staleness guard for content changes inside an
unchanged folder link (re-link and Re-run cover it meanwhile), admin-editable *rules*
(the prompt allow-list — step 2 of the admin graduation, distinct from the model picker),
verifying the PRINT file's QR byte-for-byte (needs a PDF rasteriser), and any soft-block
(if ever wanted, "reds require an I've-reviewed tick" is its natural scope).

**One run at a time, and Investigate surviving a re-run (2026-07-26, migration
000346).** The reported symptom was small — "Investigate the history" answering
*That flag is not on the current report* — but the cause was not. Order prep fires
this check **twice, in parallel, by design**: linking the Dropbox folder trips the
000337 auto-run (`force:true`), and the reviewer opens the review page seconds later,
which auto-runs it too — and with no report cached yet, that second call ran the
whole thing again. Both wrote `orders.artwork_check` blind, so the last to finish
won. Live trace, order 403922: folder linked 11:00:12 → run A starts; page opens
11:00:17 → run B starts; run B finishes 11:01:23 and is **what the reviewer read**;
run A finishes 11:01:34 and is **what the order stored**; order placed 11:02:20. Two
full Opus passes over the print files per order, and the stored record of the check
is a different run from the one the human signed off.

The fix has two halves. (1) **A run claim** (`orders.artwork_check_running_at`): the
first caller claims via a conditional UPDATE — Postgres serialises the row, so
exactly one wins — and the second **waits for that run's report** instead of starting
its own, including when a report is already cached and even for a `force` request
(the report about to land IS the fresh one; showing the reviewer the copy it's about
to replace is the whole bug). Storing the report and clearing the claim are the same
patch, so a waiter never sees one without the other; a claim older than 5 minutes
counts as an abandoned run, so nothing can wedge an order out of being checked.
Orders only — the pre-send proof check has no auto-run and no structural race.
(2) **Tolerant flag resolution** (`resolveReportFlag`, tested): card labels are
model-written free text, reworded on every run ("Andrew Forbes — back" vs "Andrew
Forbes — back (03_AndrewForbes_Steel.ai)"), so an exact-match lookup meant *any*
re-run killed every Investigate button on the open page. Three routes, most exact
first: same label → same label once normalised (parentheticals dropped) → same person
and same field when that is unambiguous. It refuses rather than guesses: two people
flagged on one field never resolve. A genuine miss now returns the report the
database actually holds, and the page **swaps it in with a plain-English notice**
instead of leaving a dead button on a report that no longer exists.

---

## 2026-07-27 — cut-through dropout detection, LIVE (#565 offline, #566 live, fn v18)

**The failure.** On metal, words and shapes are often cut clean THROUGH the card.
Any closed middle — the bowl of a `P`, the centre of an `O`, the inside of a ring —
has to be tied back to the card by a small supporting **strut**, or that piece falls
out at the supplier. Skyfall **403813** shipped with the bowl of the `P` in "P4:13"
untied, on a card where every other counter was strutted correctly: every swirl in
the border, every bar in the logo, the crossbar of the `4`. One was missed. (That
order predates the check going live, so nothing missed it — it did not yet exist.)

**The framing that made it decidable.** Not "does this letter have a strut" — a
judgement call, and an unbounded one. After cutting, the card is a 2D region: flood
the metal inwards from the trim edge, and anything the flood never reaches is, by
definition, a piece that falls out. No letter list, no threshold, and correctly
strutted artwork produces nothing at all. Same principle as `qrDecode.ts`: compute
the answer and hand it to the model as evidence rather than asking it to eyeball a
0.4–1.2 mm detail (a few pixels at page scale — and asked to judge it directly, the
model got the Snap-on 403902 case wrong, calling a back cut 17% larger than its front
"expected construction").

**Telling a cut from printed white** is the other half — both are CMYK 0,0,0,0. Rob
confirmed the studio invariant: a cut-through **always** reads mirrored on the other
side. So each white region is matched against the mirrored opposite face. Three
successive tightenings, each earned from a real order:

1. *Colour alone* fires on white QR codes and white phone numbers — 3 of the first
   20 files (Black Owl 403918, Subrosa 403909, Webster 403913).
2. *One-directional coverage* lets a small shape inside a bigger mirrored one score a
   perfect 1.0 — the `o` of "develop" on carbon-fibre **403880**. Fixed by requiring
   the match to be **reciprocal**.
3. *Reciprocal is still not enough* — in mirrored monospaced text an `o` lands exactly
   on another `o`, so the match is honest (NATO-alphabet card **403874**, 3
   coincidences among 335 letters). Fixed by also requiring the **neighbourhood** to
   agree. Deliberately local rather than a global "most of the white must mirror"
   rule, which would throw away a genuine small cut logo on a mostly-printed-white
   card; there is a test for that case.

**One-sided cards.** No opposite face means no mirror test — but that only matters if
it changes the answer. Take the pessimistic reading first (assume all the white is
cut) and see whether anything comes loose. **Five of six** real one-sided cards settle
outright. The sixth (BMW of Dublin 403920, whose roundel would shed its whole centre)
reports as a conditional at severity review, worded "if this white is cut through, N
pieces would come loose".

**Three things previously reported as unreadable were not.** A page content stream
that ends early still yields 36 KB of good paths (403828) — keep what inflates, mark
it partial, and never report a quiet result on partial artwork as clean, since the
missing tail could hold the loose piece *or* the strut. A die/cutter outline drawn in
strokes only (403845 BERTHA.ai) has no printed artwork — "nothing cut", not a failure.
And "the other side could not be read" was being reported as "only one print file
supplied", sending the reviewer after the wrong thing. Also: the trim box is now read
from the whole file, not the first 400 KB (on an 851 KB `.ai` the page dictionary sits
at 432 KB, and missing it silently downgraded us to guessing the card from its biggest
shape).

**Validation — 148 card faces from 59 real orders.** Flags Skyfall 403813 on both
faces and **nothing else**, while recognising cut-through artwork on 19 other orders
and staying silent on all of them. Final split: 2 dropout, 1 possible (one-sided), 57
clean, 86 nothing cut, 2 not checkable (both genuinely damaged files). Uncheckable
fell 9 → 2 across the tightenings. ~40 ms per face against the ~45 s the check already
takes.

**Wiring.** `_shared/artworkCheck/cutThrough.ts` (pure, no new dependency, uses only
`DecompressionStream` + typed arrays so it runs unchanged in the edge runtime).
Gated on `isCutThroughMaterial`, so a plastic job pays nothing. The result goes to the
model as a CUT-THROUGH CHECK context block (prompt rules tell it to report the
measurement and NOT re-judge it from the page images) **and** is merged into the
report afterwards by `applyCutThroughFindings` — `deriveVerdict` runs on findings in
code, so a deterministic safety result must not depend on the model repeating it. A
finding the model already made about the same file is left alone.

**Grading.** A confirmed loose piece is **defect** (red): measured rather than judged,
and the cards come back wrong if it ships — the "would we bet a reprint on it" bar.
The one-sided conditional is **review** (amber). Verdict stays advisory either way; a
red ✗ does not block Confirm. Severity is one line in `applyCutThroughFindings` if it
proves noisy.

**Fail-safe.** Any failure yields no faces and the check carries on exactly as before;
unreadable files report "could not check", never clean. Deploying this can only match
or improve prior output.

**Tests.** 121 in `cutThrough.test.ts` (`pnpm test:cut-through`), including an
end-to-end pass over genuine PDF bytes built in the test, both false-alarm shapes as
regression fixtures, and direct verdict-integration checks. Offline batch runner
`pnpm check:cut-through <folder>`; debug renderer `scripts/render-cut-through.ts`
(white = cut, blue = printed white, red = would fall out) — how both false alarms were
caught, and how any future flag can be audited.

**Open.** One real defect in the corpus: Skyfall proves it fires, but live
effectiveness is what we are now watching. Topological, so a strut that is present but
hairline reads as clean. `deno check` was not run (Deno absent locally); byte-verified
against main after deploy instead.
