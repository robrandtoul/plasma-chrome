# Direct order hand-off to Stock Control — build spec

**Status: Phase 0 + Phase 1 authored (branch `feat/order-handoff-shadow` — migrations 000331–000333,
place-order shadow mode, mapping tab, contract test); nothing applied to live yet.** Written
2026-07-20 from a six-agent investigation of both sides of the current hand-off (this repo's
`place-order`, Stock Control's live parser functions and tables, and the design history), two
independent designs, and an adversarial review; amended the same day where authoring against the
live database corrected the design (see §4 — the planned unique index was wrong). Decisions taken
by Rob on 2026-07-20: he owns Stock Control (so both halves are coordinated in one plan), the
prototype warning fix is in scope, and the parallel-run window is defined by order coverage, not the
calendar.

## 1. Goal

Replace the machine-parsing of Help Scout text with a **direct database write** at the moment the
designer clicks Confirm. The Help Scout production note and the supplier email keep being sent
exactly where they go today — as human communications and the audit trail on the customer's
conversation — but no machine ever reads them again. Once the new path is proven, the wording of
both becomes freely editable (admin templates), and the strict-format guard rails are deleted.

## 2. How it works today (what we're replacing)

- `place-order` (this repo) composes a strictly formatted text block: a staff **note** on the
  customer's Help Scout thread for in-house orders, or a **new Help Scout conversation emailing the
  supplier** for outsourced orders. The conversation subject is set to `Order <number> - <name>`.
- Two Stock Control edge functions ingest by webhook: `helpscout-inhouse-order` (fires on
  `convo.note.created`; recognises a staff note carrying `Qty:` + `Card:` lines; parses the order
  number from the subject) and `helpscout-outsourced-order` (fires on `convo.created` /
  `convo.thread.created`; recognises a conversation whose primary customer email matches an active
  supplier; parses `Qty:` / `Material:` / `Thickness:` / `Finish:` / `Must ship by:`).
- Both parsers are first-wins per key and **silently ignore unknown lines**. The in-house parser
  fuzzy-matches the `Card:` value against `public.materials`; the outsourced parser matches
  `Material:` exactly against active `public.outsourced_product_types`. Failures bounce back as
  `PlasmaDesign stock-control:` correction notes — except the worst case: an in-house note missing both Qty and Card lines
  **imports nothing and tells no one**.
- The only durable link between the two systems is the 6-digit order number as text
  (`proofs.orders.stock_order_number` ↔ `public.orders.order_ref` /
  `public.outsourced_orders.customer_order_ref`). No cross-schema FKs exist.
- The strict format WAS defended in this repo by `checkEditedMessage` + `SPEC_KEY_RE` in
  `place-order`, mirrored in `src/lib/handoffMessageCheck.ts`, the OrderReviewPage warning box and
  `sanitiseInhouseNote`. **Phase 3 deleted all of that** (see §6). `sanitiseInhouseNote` is the one
  survivor, applied only in `off`/`shadow` where the parser genuinely still reads the note; the
  letterpress bracket rules in `buildCardLine` stay, because `card_line` is the direct path's
  material-resolution key, not mere phrasing.

Known gaps this replacement also fixes:

- **The PROTOTYPE warning never reaches the job card.** Prototype orders lead with
  `PROTOTYPE SAMPLE — up to N exact copies, NOT a production run.` — an unlabelled line the parser
  drops. Anyone working purely from Stock Control's screen sees an ordinary order.
- **Per-person splits** are stored as a notes string, not data.
- **Stock colour** is smuggled through the `Card:` line rather than referenced by id.
- Validation happens **after** sending (correction notes), not before.

## 3. Design overview

The architecture is "direct RPC write, parser as backstop" with the observability and contract
discipline grafted on (the adversarial review's hybrid verdict).

### 3.1 The write path

**New SQL function `public.create_order_handoff(p_payload jsonb, p_spec_snapshot jsonb default null, p_validate_only boolean default false) returns jsonb`.**
SECURITY DEFINER, `search_path = public, proofs, pg_temp`; EXECUTE revoked from `public`, `anon`,
`authenticated`; granted to `service_role` only. It lives in the `public` schema because Stock
Control owns order intake; Rob owns both apps, so it is authored here as reviewed SQL and applied
via MCP like any migration.

⚠ Public-schema functions default to executable-by-PUBLIC — the revoke is mandatory, and it is the
*inverse* of the proofs-schema no-default-grants footgun.

In one transaction it:

1. **Dedupes as success.** The direct path's idempotency key is the proofs order itself:
   `proofs.orders.handoff_at` is stamped in the same transaction as the Stock Control insert, and a
   re-call for an order that already has it returns `{already_imported: true}` without writing.
   (In-house additionally inherits `create_inhouse_order_from_note`'s own number dedupe + hand-keyed
   adoption — reading the live definition showed the RPC does carry those checks, not just the
   webhook.) Refs are `trim()`ed everywhere they're compared.
2. **Validates** everything the parsers used to bounce on, plus what they silently dropped:
   material id exists and isn't archived, letterpress trio resolves via
   `_resolve_letterpress_combo`, product type and supplier active, qty positive, split sums to qty,
   order number well-formed **and not already live in Stock Control under a different conversation**
   (the typo'd-folder-number check — the parser bounce used to be the second pair of eyes here).
3. **Inserts the Stock Control rows** — `public.orders` + `public.order_lines` (in-house, arriving
   unscheduled on the to-schedule rail exactly as today) or `public.outsourced_orders` (with the
   lead-time/arrival defaulting the existing RPC does). Reuses the guts of
   `create_inhouse_order_from_note` / `create_outsourced_order_from_email` — including the
   adopt-a-hand-keyed-order behaviour, which must be integration-tested against a manually entered
   order before Phase 2. The composed job-card `notes` string keeps today's `" | "` shape **and now
   includes the prototype marker** (and a structured `is_prototype` flag if we add the column — §4,
   optional).
4. **Flips `proofs.orders`** — the `markPlaced` writes (status → `fulfilled`,
   `order_spec_snapshot`, supplier details, `supplier_overs`) plus the new stamps `handoff_at` and
   `handoff_payload` (the exact jsonb it was called with). Placement and hand-off become atomically
   inseparable: an RPC failure means nothing changed anywhere, and Confirm can simply be retried.

`p_validate_only = true` runs steps 1–2 and returns errors without writing — this is what preview
calls, so every failure class that used to be a post-send correction note (or silence) becomes an
error in the designer's face on OrderReviewPage before anything is sent.

Returns `{ok, validate_only, already_imported, sc_order_table, sc_order_id, problems[], warnings[],
resolution}` — each problem/warning a `{code, message}` pair, `resolution` the ids/names the
importer settled on.

### 3.2 The payload contract (v1)

The jsonb payload is the contract between the apps. Versioned (`payload_version: 1`); the importer
ignores unknown keys and never fails on them; the version bumps only on a breaking reshape. New
fields (bundle ids, reprint links, future spec items) are new keys — no format renegotiation, ever.

```jsonc
{
  "payload_version": 1,
  "pv_order_id": "<proofs.orders.id>",     // the order being placed — the RPC's proofs-side target
  "placed_by": "<profiles.id>",            // the designer clicking Confirm (→ fulfilled_by)
  "stock_order_number": "403792",          // trimmed; the spine key, minted from the Dropbox folder name as today
  "route": "in_house",                     // "in_house" | "supplier"
  "customer_name": "Glosfume",
  "project_name": "Glosfume",
  "helpscout_conversation_id": "123456789", // in-house: the proof thread. Supplier: null at write time (§3.4)
  "qty": 100,                              // the customer quantity — invoice/finishing truth
  "supplier_qty": 110,                     // supplier route: qty + overs, explicit (in-house: = qty)
  "supplier_overs": 10,
  "prototype": { "is_prototype": true, "max_copies": 2 },   // null when not a prototype
  "material": {
    "pv_material_id": "<proofs.materials.id>",  // drives the §3.3 mapping lookup
    "code": "plastic_satin",
    "display": "Satin Plastic",
    "card_line": "Satin Black Plastic",         // buildCardLine output: human echo + name-match input; null on the supplier route
    "letterpress": { "front": "Natural", "core": "Black", "back": "White", "gilding": true }  // raw names incl. "(default …)" — the combo resolver strips
  },
  "supplier": {                            // supplier route only, else null
    "supplier_id": "<public.outsourced_suppliers.id>",
    "supplier_name": "QX Metals",
    "product_type_name": "Carbon fibre",   // resolved to an id inside the RPC (§3.3)
    "specific_type": "Carbon Fibre CNC",
    "thickness": "800um",
    "finish": "Mirror",
    "must_ship_by": "2026-07-13"
  },
  "date_required": "2026-06-30",
  "inks": { "front": "White", "back": "Black" },
  "packaging": "Domestic",
  "split": [ { "name": "Joe Bloggs", "qty": 50 }, { "name": "Jane Doe", "qty": 50 } ],
  "artwork": { "dropbox_url": "https://…" },  // manifest only in v1 — files still travel on the note (§3.5)
  "note": "free text from the designer"
}
```

The composer is `buildHandoffPayload` in `supabase/functions/_shared/orderHandoff.ts` (pure, no
imports), byte-pinned by golden fixtures in `orderHandoff.test.ts` (`pnpm test:handoff-contract`) —
any reshape fails the test and forces a deliberate `payload_version` decision. `order_spec_snapshot`
rides as a separate RPC argument (`p_spec_snapshot`) built from the same in-scope values, so the two
structured records can't drift.

This section is the contract of record; it is mirrored into the Stock Control repo verbatim when
Phase 0 is authored, and both copies change together thereafter.

### 3.3 Material resolution becomes explicit (and fuzzy matching dies)

New column **`proofs.materials.stock_material_id uuid`** — a soft reference to
`public.materials.id`, no cross-schema FK (the 000258 house pattern) — set per material on the new
**Catalogue data → Stock materials tab** (per the admin house rule: a per-material value = a
Catalogue data tab, not a new sidebar entry). Resolution executes **inside the RPC** (one SQL
implementation for validate and execute, driven by sender-supplied inputs) and is surfaced to the
designer through the validate-only response on the review page:

1. **Explicit mapping** (`stock_material_id`) wins — the 1:1 families (metals, carbon, papers,
   full-colour/translucent plastic).
2. **Exact name match** on the payload's `card_line` otherwise — which already IS the intended
   Stock Control name for the option-driven cases: satin/tinted/acrylic emit `orders.stock_colour`
   (a verbatim `public.materials.name`, picked live from Stock Control's catalogue — the
   established pattern) and wood emits the title-cased species. One gentle loosening only (trailing
   "plastic"/"card(s)" dropped); **never token-fuzzy** — zero or multiple matches is a named
   problem, not a guess.
3. **Letterpress** passes the front/core/back trio through; `_resolve_letterpress_combo` resolves
   it inside `create_inhouse_order_from_note` as today.

Every branch validates at preview. An unmapped material is a named preview error pointing at the
mapping tab — it cannot reach production malformed.

**The customer name on the Stock Control job is route-aware** (migration 000335, from a shadow
finding on 2026-07-22). It must mirror the name the legacy parser reads from the Help Scout
**subject** today, and the two routes build that subject differently: the in-house note subject is
`Order N - {project_name ?? customer}` (the Dropbox folder name — which for a trade reseller is the
**end client**, e.g. "The Cue Club", not the reseller "Premier Eco Cards"), while the supplier
subject is `Order N - {customer}` (the company). So `create_order_handoff` writes the folder/project
name on the in-house route and the company name on the supplier route, keeping the workshop's job
label byte-identical to today. The payload carries both `customer_name` (company) and `project_name`
(folder) as distinct facts; the RPC picks per route and echoes its choice back in
`resolution.customer` so the shadow parity check reads the decision rather than re-deriving the rule.

**Supplier "must ship by" always leaves a delivery buffer** (a shadow finding on 2026-07-23, order
403917). It's computed in `place-order` as `date_required − shipping_buffer`, and feeds both the
supplier email and the payload's `must_ship_by` from the same value, so they never disagree within a
placement. A supplier's configured `default_shipping_days` wins; a **domestic** supplier with none
set (Swype, Solopress) now gets a **2-day buffer** — one day supplier→Plasma, one day
Plasma→customer (Rob's rule) — instead of the old zero, which told the supplier to ship on the very
day the customer needed the cards. International suppliers with no transit set stay at 0. This is a
`place-order`-only change (no migration; the RPC faithfully writes whatever `must_ship_by` the
payload carries) and it improves live supplier emails today, not just Phase 2.

### 3.4 Confirm sequence and failure surfacing

Confirm becomes **RPC-first**:

1. Call `create_order_handoff` (atomic — see §3.1). On failure: clean error, nothing sent, retry
   freely. `sent_not_recorded` becomes structurally impossible for the machine hand-off.
2. Post the in-house note (subject set first, as today) / create the supplier conversation — now
   human artefacts. Stamp the done-once flags `production_note_posted_at` /
   `supplier_email_sent_at` (the 000309 idiom).
3. Supplier route: `place-order` **owns** stamping the new conversation's id onto the
   `outsourced_orders` row; the webhook's ref-based adoption (§4) is the fallback only — one owner,
   not "or".

An RPC **failure** at step 1 stamps `proofs.orders.handoff_error` (cleared on the next success) so
the Orders page can render "Import failed — Retry" from persisted state rather than a toast the
designer may have dismissed.

A send failure after the RPC commits is the one genuinely new failure mode, and **both** routes get
the same treatment in the same PR as go-live: an Orders-page "Needs action" row keyed on the null
flag, with a single-purpose retry (double-send-proofed by the flag). The in-house retry re-runs the
subject-set **and** the note as a unit — a note retried without the subject would leave the Phase-2
backstop parser with nothing to key on. The in-house note failure matters as much as the supplier
email: the workshop reads that note, and in Phase 2 the backstop parser can't ingest a note that
was never posted.

A retried Confirm that crashed between note-post and flag-stamp may double-post the note (humans see
a duplicate; the parser no-ops on the dedupe). Cosmetic, accepted.

`status='fulfilled'` now stamps **before** the sends rather than after. Known readers of fulfilled
(Orders-page pipeline tiles, `send-order-reminders`' stop condition, `_project_order_tracking`'s
fallback branch, Stock Control's reads of `proofs.orders`) are enumerated and re-checked as a build
task — expected benign because the flags cover the gap, but it must be verified, not assumed.

### 3.5 Artwork: deliberately unchanged for now

The direct path does **not** write Stock Control's `order-artwork` bucket or `order_attachments` in
Phase 2. The note still carries the attachments, and the live ingester's `syncArtworkBestEffort`
mirrors them onto the job card **even when the order was already imported** — verified against the
deployed source — so attachments keep working with zero new code. (A naive direct upload would
double every attachment: the two paths' idempotency keys don't intersect.) Direct
Dropbox-to-bucket artwork, which would lift the Help Scout 10 MB/file cap to Stock Control's 25 MB,
is a Phase-3+ item with a shared idempotency key designed on the Stock Control side.

### 3.6 The mode switch

`proofs.settings.direct_handoff_mode text not null default 'off'`,
CHECK in (`'off'`, `'shadow'`, `'live'`) — the `ai_drafts_mode` house pattern, editable on Admin →
Settings. `off` = today's behaviour byte-for-byte. `shadow` = today's behaviour plus a
validate-only RPC call per confirm, payload stored in `handoff_payload` for parity checking.
`live` = the §3.4 sequence. Reversible in seconds, which is the kill switch a trigger-based design
would lack.

## 4. Stock Control-side changes (SQL only; no Stock Control app deploys required)

All appliable via MCP/dashboard as reviewed SQL, same ceremony as this repo's migrations. Authored
as migrations **000331** (items 1–2) and **000333** (item 3):

1. **⚠ NO unique index on `customer_order_ref`** — the spec originally called for one, but checking
   live (2026-07-20) found four order numbers each carrying TWO legitimate live supplier jobs
   (403727 gold cards at QX + laminated at Solopress; 403752 two metals at QX; 403769 two
   suppliers; 403790 original + hand-raised reprint). One customer ref to many supplier jobs is a
   supported shape, so uniqueness is the wrong rule. Instead, the double-import race is closed by
   **adoption (item 2) plus ordering**: the direct row COMMITS before place-order creates the
   supplier conversation, so the row to adopt always exists before the webhook can fire.
2. **Adoption** in `create_outsourced_order_from_email`, keyed on trimmed ref **+ supplier +
   quantity** (quantity discriminates two jobs at one supplier under one ref), scoped to rows from
   the last 14 days with `helpscout_conversation_id IS NULL` and not cancelled, newest first. The
   webhook fills the conversation id ONLY — every other field was written by the direct path and is
   authoritative. This doubles as the fallback conversation-id stamp (place-order owns the primary
   stamp, §3.4).
3. **`import_source text`** (nullable, no default) on `public.orders` and
   `public.outsourced_orders`: `'direct'` = written by the direct path; NULL = anything else
   (webhook-parsed AND hand-raised, honestly). This is the parallel-run telemetry AND the permanent
   alarm (§6).
4. **`public.create_order_handoff` itself** (§3.1, migration 000333).
5. **Optional, Rob-approved scope**: `is_prototype boolean` on `public.orders` (the marker rides
   the notes string regardless), and structured split storage — both nice-to-haves the payload
   already enables; can land any time after cutover.
6. **The two webhook parsers need no changes** and stay deployed: during rollout as the backstop,
   afterwards as the first-class path for genuinely hand-typed orders (a supplier email written by
   hand, the workshop's in-app Add-order form). Their auto-created orders simply keep reading
   `import_source = 'note_parse'`.

## 5. Proofs-side changes (this repo)

Authored as migration **000332** (`proofs` schema):

- `proofs.materials.stock_material_id uuid` (§3.3).
- `proofs.orders.handoff_at timestamptz`, `handoff_payload jsonb`, `handoff_error text` (last RPC
  failure, cleared on success — backs the "Import failed — Retry" chip; in shadow mode it carries
  validation problems prefixed `shadow:`), `production_note_posted_at timestamptz`,
  `supplier_email_sent_at timestamptz`.
- `proofs.settings.direct_handoff_mode` (§3.6).

Columns ride existing tables, so they inherit those tables' explicit grants — no new grant matrix
needed (but say that in the migration comment; don't cite the retired standalone project's 000176).

Code:

- `supabase/functions/place-order/index.ts` — the payload composer (one function feeding the RPC,
  `order_spec_snapshot`, and the human message renderers), mode gating, RPC-first confirm, flag
  stamps, conversation-id stamping.
- `src/pages/OrderReviewPage.tsx` — preview-time validation errors from `p_validate_only`; later
  (Phase 3) drop the warning box + lockstep mirror and add a small read-only structured-spec summary
  rendered from the payload, so the designer confirms the machine spec and the human wording as two
  explicitly separate things.
- `src/pages/OrdersPage.tsx` — hand-off status chip ("In workshop system" / "Import failed —
  Retry") and the Needs-action rows for failed sends.
- New admin Catalogue data tab for the material mapping.
- **The contract test** — `supabase/functions/_shared/orderHandoff.test.ts`
  (`pnpm test:handoff-contract`): field rules plus two byte-pinned golden payloads covering
  letterpress-with-default-suffix colours, satin stock colour, prototypes, splits and supplier
  overs. The composed job-card **notes** strings live in the RPC's SQL (mirroring `buildSpecNotes`'
  `" | "` shape — the one remaining cross-repo string, flagged in lockstep comments in 000333) and
  are verified against reality by the Phase 1 parity check rather than a unit test.

## 6. Rollout

**Phase 0 — Stock Control prep.** Apply migration 000331 (§4.2–4.3: adoption + `import_source`).
Pure safety net; zero behaviour change. Must land strictly before anything else.

**Phase 1 — shadow.** Ship the proofs migration + RPC + place-order changes with mode `'shadow'`.
Confirm behaves exactly as today, but every confirm stores `handoff_payload` and runs
validate-only. Meanwhile: populate `stock_material_id` for every material resolved via §3.3
branch 1 — the 1:1 families; satin/tinted/acrylic, wood and letterpress need no mapping row
(preview names any gap either way) — and run the parity query — `handoff_payload` fields joined against the rows the
parser actually created for the same order numbers (material id, qty, deadline, product type,
ship-by, letterpress trio). Fix divergences until clean.

**Phase 2 — live, parser as backstop. BUILT 2026-07-24.** Direct write first
(`import_source='direct'`), note/email after, **wording still strict** — `checkEditedMessage` and
the format rules stay in force so the parser remains a fully functional backstop. Shipped in one PR:
the RPC-first confirm sequence, the Needs-action surfacing + one-click retry (§3.4), and migration
**000345** hardening the supplier insert. Flipping `direct_handoff_mode` to `'live'` is the cutover
and is reversible in seconds.

⚠ **`loadHandoffMode` no longer coerces `'live'`→`'shadow'`**, so with this deploy in place the
setting IS the switch — deploy first, then flip.

Hard-won details from the pre-go-live review (all fixed; each was a real defect):

- **The supplier insert had no dedupe key of its own** — `handoff_at` was the only one, and it lives
  on the *caller's* row. Two designers confirming at once, or a re-place retried after a timeout,
  could email a supplier twice = a duplicate production run and a real bill. Migration **000345**
  gives the supplier branch its own idempotency (trimmed ref + supplier + quantity, non-cancelled
  `import_source='direct'` rows from the last 14 days) and sets `already_imported` on that route so
  the caller can tell. `place-order` then **refuses to send** when the RPC reports the job was
  already there (except on a deliberate message retry). Verified on live in a rolled-back
  transaction: no duplicate job, retry reuses the same job, duplicate confirm writes nothing.
- **`already_imported` is ambiguous** — it means both "nothing happened" (the early return) and "an
  existing job was adopted". `sc_order_id == null` is the unambiguous discriminator and is what
  decides whether to audit.
- **The supplier send is stamped the instant Help Scout accepts it**, before the best-effort
  customer-thread copy — otherwise a timeout after a large attachment upload leaves no evidence and
  a retry emails the supplier again.
- **A re-place must clear `handoff_at`** or the RPC treats it as already-imported and silently
  creates nothing. It only ever clears while the order is still `revision`; once the RPC commits,
  a retry is classified as a *message retry* instead, which is what stops a second job.
- **Placement gates (artwork check, proof-approved) are skipped on a message retry** — the job is
  already in production, so re-gating would strand it with the workshop never told.
- **`isMessageRetryCandidate` is gated on live mode**, so a rollback to `shadow` restores the old
  gates exactly.
- A post-commit `return` inside the supplier `try` (unresolvable mailbox) **throws** instead, so it
  can't report a placed order as a plain failure with no retry affordance.

Deferred, deliberately: the `import_source`-NULL backstop alarm has no bespoke admin widget — it
rides the daily scheduled shadow/parity report, which is automatic and Rob-facing. Build the widget
if the report ever stops being read.

⚠ **Migration numbering:** this work's files collide on `000335` (with `000335_proof_images_allow_png`)
because a number was picked by incrementing instead of running `ls supabase/migrations/`. The repo
already tolerates duplicate prefixes (000217, 000228–000230, 000279, 000307), and each file is
applied via MCP under its own name, so the collision is cosmetic — but it is exactly the footgun
CLAUDE.md warns about. `000345` was chosen correctly by listing.

**Phase 3 — free the wording. BUILT 2026-07-27.** Shipped in two parts:

*Stock Control side* (its own repo, PR #238; deployed helpscout-inhouse-order v45,
helpscout-outsourced-order v47). Both importers now recognise a directly-written job
(`import_source='direct'`) and return quietly instead of importing or posting correction notes. The
gate is **self-limiting in the right direction** — it only suppresses when a job ALREADY exists, so
a failed direct write leaves nothing to find and the old import path runs exactly as before. The
in-house change doubles as the **artwork fix**: files reached a job card only via the parser
mirroring the note's attachments, and both that mirror and the admin sync-attachments sweep gave up
before reading the subject (live: 126 in-house jobs/90d, 85 carrying artwork). It now resolves the
job from the subject and falls back to the newest staff thread carrying files.

*proof-viewer side.* Deleted `checkEditedMessage`, `SPEC_KEY_RE`, `SPLIT_SHAPE_RE`,
`src/lib/handoffMessageCheck.ts` + test + the `test:handoff-check` script, the `critical_lines`
plumbing and the OrderReviewPage warning box (now a non-blocking "this message is empty" advisory);
dropped the refuse-without-`{order_details}` guard server-side and in Admin → Outsourcing. Both
messages render from admin-editable templates via the existing `renderTemplate`
(`{var}` + `{? var}…{/?}`): the new `inhouse_production_note` (migration 000361) and the existing
`supplier_order_email`, which gained individual variables alongside the `{order_details}` composite.

Hard-won details:

- **The shipped defaults reproduce the old messages byte-for-byte**, so day one is a visual no-op.
  Pinned by `pnpm test:inhouse-note`, which reimplements the old line-by-line builder and diffs it
  against the rendered default across every order shape. The default body exists in FOUR places
  (place-order's constant, `DEFAULT_BODIES`, migration 000361, the test) — change one, change all.
- **Substitution must be one-shot.** `renderTemplate` re-scans its own output, so a value inside a
  conditional block is read twice: a designer note saying "match the {logo} file, qty is {qty} not
  50" came out with `{logo}` deleted and `{qty}` replaced. `place-order` parks brace characters in
  the VALUES for the duration of the render. Covered by the test.
- **`sanitiseInhouseNote` survives, gated on mode.** In `off`/`shadow` the parser really does read
  the note, so a `Bob — 50`-shaped note line must still be neutralised or it folds into the real
  per-person split. Removing it unconditionally would have regressed a rollback.
- **The supplier `{note}` variable must be listed**, or an admin who lays the email out by hand
  silently drops the designer's note to the supplier.
- Migration 000361 must be **schema-qualified** (`proofs.reply_templates`) — the admin group renders
  nothing without the row, so a failed seed hides the whole feature.

⚠ **After Phase 3 the mode switch is NO LONGER a clean rollback.** Flipping back to `shadow` with
edited wording means the parser can't read the message and the order lands nowhere. Admin → Settings
→ Workshop hand-off warns on the way out of `live`. Reset any edited wording to default first.

Rollback at any phase: flip the mode setting back. Deploy discipline throughout: migrations via
MCP/dashboard first, `place-order` from main after merge (mode-gated, so ordering is safe),
byte-verify deploys.

## 7. Failure modes and how you'd know

| Failure | Behaviour | How it surfaces |
| --- | --- | --- |
| RPC fails at confirm | Nothing changed anywhere; Confirm shows the error | Designer retries freely |
| Direct path silently wrong in Phase 2 | Backstop parser imports it | automated alarm: fulfilled order whose SC row has `import_source` NULL |
| Unmapped material / bad trio / inactive supplier / dodgy order number | Blocked at preview with a named fix | OrderReviewPage error before send |
| Note or supplier email fails after commit | Order exists in Stock Control; message didn't go | Needs-action row + flag-keyed retry |
| Double-import race (outsourced) | Closed by Phase 0 adoption + commit-before-conversation ordering | Same (ref, supplier, qty) twice within days, one conversation-less — checked in Phase 1 |
| Reworded note loses Qty/Card (today's silent black hole) | Irrelevant once live — the note isn't load-bearing | n/a (this is the point) |
| Re-place after a Stock Control cancel | Dedupe treats only non-cancelled rows as already-imported; the human attestation checkbox stays | As today |

## 8. Explicitly out of scope

- Cancelling a Stock Control job stays human (attestation checkbox) — no machine cancel path.
- Direct artwork upload (Phase 3+, needs a shared idempotency key — §3.5).
- Migrating the workshop's in-app Add-order form onto the handoff RPC (optional later; the parser
  path keeps serving it).
- Bundle/combined-payment/reprint flows: unaffected — placement is per-order and post-payment;
  reprints already mint a fresh number via `clone-order-folder`.
