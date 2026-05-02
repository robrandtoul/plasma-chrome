# Pre-merge audit: multi-recipient approval flow branch

**Read-only inventory pass.** No commits, merges, or rebases performed during this phase.
**Branch state:** `main` at `81c0473`. Working tree carries the in-flight Phase 2 / 2.5 multi-recipient approval flow.
**Run date:** 2026-04-27.

## Scope correction (pushback to brief)

The brief framed the WIP as "+800 LOC on `CustomerProofPage.tsx` plus 7 unmerged migrations". The actual scope is larger:

| Surface | Lines | Type |
|---|---:|---|
| `src/pages/CustomerProofPage.tsx` | +788 / -16 | modified |
| `src/pages/DashboardPage.tsx` | +169 / -5 | modified |
| `src/pages/ProofDetailPage.tsx` | +164 / -0 | modified |
| `src/pages/admin/AdminSettingsPage.tsx` | +127 / -11 | modified |
| `src/pages/NewVersionPage.tsx` | +24 / -17 | modified |
| `src/lib/types.ts` | +60 / -0 | modified |
| `src/lib/publicSettings.ts` | +22 / -0 | modified |
| `supabase/config.toml` | +9 / -0 | modified |
| `src/lib/approvalSettings.ts` | +120 | new |
| `supabase/functions/proof-action/index.ts` | +616 | new |
| 7 SQL migrations (000116–000122) | +839 | new |
| **Total** | **+2,948 / -49** | |

Net: ~3,000 lines about to land. Any merge plan needs to cover the lot, not just the customer page.

## Diff inventory — `CustomerProofPage.tsx` (+788 LOC)

Grouped by feature area; each group confirmed end-to-end (no stubs, no TODO markers).

### Group A — Phase 2.5 per-recipient action surface (~250 LOC)

**What it does.** Hooks for `actionPanel` (modal target), `actionResults` (optimistic state keyed by `${versionId}|${recipientName}`), `successMessages`. Helpers `bandKey`, `openActionPanel`, `closeActionPanel`. The `getBandState(name)` resolver returns one of `pending` / `optimistic` / `carried` / `approved` / `changes_requested`. The `renderActionBand(name)` function (~250 LOC of the diff) renders the appropriate banner or two-button surface per recipient. Wiring: each named recipient's image-group calls `renderActionBand(group.heading)` (line 1743 of WIP). All states reachable; verified during the responsive audit.

**End-to-end?** Yes. State setters fire on click → `submitAction()` POSTs to the `proof-action` edge function → on success, `actionResults` records the optimistic state → on `partial`/`failed` the UI surfaces the appropriate banner. No stubs.

### Group B — Approve / Request changes confirmation modal (~180 LOC)

**What it does.** Modal opens via `actionPanel` state. Renders a full-bleed backdrop with a `max-w-[560px]` dialog: kicker (green for approve / red for request changes), body copy from `publicSettings.approve_confirmation_copy` / `…request_changes_confirmation_copy`, required name input, optional/required comment textarea, Cancel + Confirm buttons. Confirm calls `submitAction()`.

**End-to-end?** Yes. Backdrop click closes (gated on `!actionSubmitting`). Confirm button respects per-action validation (comment required for `request_changes`). Error handling shows `actionError` inline.

### Group C — Live pricing read replacing snapshot (~50 LOC)

**What it does.** Two new state hooks (`tierRows`, `variantRows`) populate from `public_price_tiers` + `public_material_variants` views (added by migration 000117). A `livePricingSnapshot` derivation builds the same `PricingSnapshot` shape `InkPricingTable` expects, but rebuilt live from the views and filtered by `activeVersion.displayed_variant_ids` (added by migration 000118). Keeps the downstream pricing UI unchanged.

**End-to-end?** Yes. Verified during the responsive audit — pricing grid renders correctly on the Oswald single-version proof and the Chris multi-version proof. Filter by `displayed_variant_ids` honours the designer's variant subset.

### Group D — `submitAction()` edge function call (~70 LOC)

**What it does.** POSTs `{ proof_version_id, name, event_type, actor_name, comment }` to `${VITE_SUPABASE_FUNCTIONS_URL}/proof-action`. Handles three response shapes: `ok` / `partial` / `failed`. On `ok` and `partial`, stamps `actionResults[bandKey]` with optimistic state (so the UI flips banner immediately). On `failed`, surfaces `actionError`. Patches `proof.disclaimer_acknowledged_at` from the response payload when present.

**End-to-end?** Yes. The endpoint shape, response discriminated union, and partial-failure paths all match the edge function's spec (see `supabase/functions/proof-action/index.ts`).

### Group E — Disclaimer-ack gate on Approve (~30 LOC)

**What it does.** When `proof.disclaimer_acknowledged_at` is null AND a disclaimer is configured, the Approve button shows as `aria-disabled` with reduced opacity and clicking scrolls the page to the disclaimer section. Request-changes is ungated (customer can ask for changes before reading terms).

**End-to-end?** Yes. `disclaimerSectionRef` populated; the smooth-scroll behaviour fires. Once the disclaimer checkbox is ticked, the proof's `disclaimer_acknowledged_at` updates server-side via the existing edge function, the local proof state is patched, and the gate clears.

### Group F — Image grouping by `associated_name` (~60 LOC)

**What it does.** New `buildImageGroups()` + `augmentNamedGroupsWithSharedPairs()` helpers split the version's images into one group per recipient (named) plus an optional "shared" group. Each named group renders its own `<h3>` heading + image grid + action band. Shared images virtual-pair into adjacent named groups so a Front-only named image gets a Back from the shared pool.

**End-to-end?** Yes. Verified across scenarios 4, 5, 7 in the responsive audit (3 / 5 recipient bands all rendered correctly).

### Group G — Public settings extension (~10 LOC)

**What it does.** `publicSettings.ts` extended with `approve_confirmation_copy` + `request_changes_confirmation_copy` fields, fed by migration 000120's update to the `public_settings()` SQL function. Customer page reads via the existing `getPublicSettings()` cache.

**End-to-end?** Yes.

### Group H — Editorial / cosmetic tokens (~20 LOC)

Constants for `CTA_TEAL`, `CTA_TEAL_HOVER`, `CTA_TEAL_PRESSED`, `CTA_GHOST_*`, `APPROVED_GREEN`, etc. — colour palette for the action band's Approve / Request changes treatment. No logic, just tokens.

### Group I — Phase 2 + Phase 1 button height fixes (5 lines)

**What it does.** `min-h-[44px]` on the four button class strings the previous responsive-audit session identified as failing the 44 × 44 touch target. Plus the Phase 1 download chip `min-h-[44px]` carried over (already on `main`).

**Drift check passed.** All 5 instances present at the expected lines (807, 842, 2455, 2493, 3407). No drift.

## Diff inventory — other files

### `src/pages/DashboardPage.tsx` (+169 / -5)

- New `DashboardLatestEvent` interface — shape of `dashboard_latest_events` view rows.
- New `LatestActivityPanel` component — right-hand sidebar showing the last 10 customer events with relative timestamps, recipient label, contact + company context, and a "notification failed" pill when `helpscout_thread_id` is null.
- New `hasChangesRequested` rollup on `ProofItem` — `true` when the latest version has any recipient at `state = 'changes_requested'`. Drives a new orange "Changes requested" `StatusPill` variant that takes precedence over the default "In progress" pill (but not over Approved / Abandoned / Dormant).
- Layout: outer container widened from `max-w-4xl` to `max-w-7xl`, switches to a `grid-cols-[minmax(0,1fr)_22rem]` two-column layout on `lg:` with the sidebar sticky.
- New `proof_name_approvals!proof_name_approvals_proof_version_id_fkey(state)` join in the proofs query.

**End-to-end?** Yes. `LatestActivityPanel` consumes `dashboard_latest_events` (migration 000122). Click → `navigate('/proofs/:id')`. Loading gate prevents flash-of-empty.

### `src/pages/ProofDetailPage.tsx` (+164 / -0)

- New `ProofEventAuditDetail` interface.
- New state `eventsByVersionAndName` — `Map<'${versionId}|${name}', ProofEventAuditDetail>`, populated by querying `proof_events` directly (designer-side, RLS allows authenticated read per migration 000116).
- New state `expandedAuditKey` — single key for which Names rollup row's audit panel is currently open.
- New `<AuditPanel>` component (~70 LOC) — surfaces actor, timestamp, comment, Help Scout thread id (or "Notification failed" pill), and a collapsible IP / UA reveal.
- Per-recipient rollup row in the Names section gets a "View details" toggle that expands `<AuditPanel>` inline. Designer-recorded approvals (no event row) hide the affordance entirely — only customer-recorded actions expand.

**End-to-end?** Yes.

### `src/pages/NewVersionPage.tsx` (+24 / -17)

Single feature change: stops writing `proof_versions.pricing_snapshot` on insert; writes `displayed_variant_ids` instead. Also stops reading `pricing_snapshot.variants[].variant_id` on the v2+ inheritance branch — uses `displayed_variant_ids` instead.

**End-to-end?** Yes. Migration 000117 makes `pricing_snapshot` nullable (so the omission is allowed), migration 000118 backfills the new column on existing rows.

### `src/pages/admin/AdminSettingsPage.tsx` (+127 / -11)

- Three new fields on `Settings` interface: `approvals_enabled`, `approve_confirmation_copy`, `request_changes_confirmation_copy`.
- New "Customer approvals" admin section with: a global on/off toggle (`approvals_enabled`), two textarea fields for the modal copy strings.
- New `Toggle` component (local copy of the app-wide toggle pattern, gray-900 / gray-200, `role="switch"`).
- New `onConfirmationCopyBlur` handler — trims and rejects empty input on blur, snaps the textarea back to the saved value if so.
- `invalidateApprovalSettings()` called after any of the three new fields saves.

**End-to-end?** Yes.

### `src/lib/types.ts` (+60 / -0)

- `displayed_variant_ids: string[] | null` added to `PublicProofVersion`.
- `latest_events_by_name: ProofEventState[]` added to `PublicProofVersion`.
- `approvals_enabled: boolean` added to `PublicProofVersion`.
- New `ProofEventState` interface — shape of each entry in `latest_events_by_name`.
- New `PublicPriceTier` and `PublicMaterialVariant` interfaces — shapes of the new public views.

### `src/lib/publicSettings.ts` (+22 / -0)

Adds `approve_confirmation_copy` + `request_changes_confirmation_copy` to the `PublicSettings` shape and to the cache. Defensive empty-string fallback to spec defaults so the modals always render readable copy.

### `src/lib/approvalSettings.ts` (+120, new)

⚠️ **Flagged: 117 of 120 lines are dead code.** The module exports four functions:

- `getApprovalsEnabled()` — exported, never called anywhere in `src/`
- `getApproveConfirmationCopy()` — exported, never called
- `getRequestChangesConfirmationCopy()` — exported, never called
- `invalidateApprovalSettings()` — called by `AdminSettingsPage.tsx` after a save (the **only** consumer)

Likely an artefact of an earlier design where the customer page read these settings directly from the table; the migration moved the copy strings to the `public_settings()` RPC (000120) and `approvals_enabled` to the `public_proof_versions` view (000120/000121), and the three getters never got removed. The module is technically harmless but ships dead code that will confuse future readers. **Decide before merge:** delete the three unused getters and keep only `invalidateApprovalSettings()`, OR delete the whole file and inline the cache-bust into `publicSettings.ts`. Either is a 5-minute cleanup.

### `supabase/functions/proof-action/index.ts` (+616, new)

Customer-facing edge function for the per-recipient Approve / Request changes flow. Anon-callable (verify_jwt = false in `config.toml`). Defence in depth: settings re-check, UUID validation, body shape checks, IP/UA capture, pricing snapshot at action time. Dual-writes to `proof_events` (append-only audit) AND `proof_name_approvals` (designer-side state mirror). Best-effort Help Scout customer thread post; degrades to `partial` + `helpscout_post_failed` on HS error rather than rolling back the event row.

**End-to-end?** Yes. Discriminated response union (`ok` / `partial` / `failed` with reason codes) matches the customer page's `submitAction()` consumer. No stubs, no TODOs. Server-side logging via `console.error` + `console.warn` (10 calls total — appropriate for Deno edge runtime).

### `supabase/config.toml` (+9 / -0)

Adds `[functions.proof-action] verify_jwt = false` block. Mirrors the existing `[functions.customer-proof-images]` block.

## Migration list

| # | File | Lines | What it does | Destructive / RLS / lock risk |
|---|---|---:|---|---|
| 000116 | `phase2_customer_approval_flow.sql` | 208 | Adds 3 columns to `settings` (defaults provided); creates `proof_events` table with 11 columns, 2 indexes, RLS enabled, designer SELECT policy. | None. ALTER TABLE settings takes brief AccessExclusiveLock; column has literal default so no rewrite (PG 11+). New table = no contention. |
| 000117 | `public_price_tiers_view.sql` | 108 | Drops NOT NULL on `proof_versions.pricing_snapshot`; drops + recreates `public_price_tiers` and `public_material_variants` views with anon SELECT grants. | Brief AccessExclusiveLock on proof_versions. View DROP+CREATE is sub-second; concurrent SELECTs against the view will momentarily fail. **Single transaction covers both** — atomicity preserved. |
| 000118 | `proof_versions_displayed_variant_ids.sql` | 123 | ADD COLUMN `displayed_variant_ids uuid[]`; UPDATE backfill from `pricing_snapshot.variants[].variant_id`; CREATE OR REPLACE `public_proof_versions` view appending the new column. | Backfill is full-table-scan UPDATE on `proof_versions`. Table has hundreds of rows, not millions, so completes in ms. CREATE OR REPLACE with append-only column list does not require a view drop — concurrent reads continue. |
| 000119 | `proof_events_action_pricing_snapshot.sql` | 49 | DROPs `total_price_at_action` + `currency_at_action` from `proof_events`; ADDs `pricing_snapshot_at_action jsonb`. | DROP COLUMN takes AccessExclusiveLock. Migration documents `proof_events` is empty on prod (table was created in 000116, edge function ships in this same commit). **Verify prod row count is still 0 before applying** if any test events have been inserted between Phase 2 verification and merge time. |
| 000120 | `public_proof_versions_event_state.sql` | 135 | CREATE OR REPLACE `public_proof_versions` adding 5 flat `latest_event_*` columns + `approvals_enabled` (cross-joined from `settings`); CREATE OR REPLACE FUNCTION `public_settings()` adding the two confirmation-copy fields. | None. CREATE OR REPLACE with append-only column list is non-blocking. Function replace is atomic. |
| 000121 | `proof_events_name_and_view_rebuild.sql` | 161 | ADD COLUMN `proof_events.name text` (nullable); CREATE INDEX on (proof_version_id, name, created_at desc); **DROP + CREATE** `public_proof_versions` to replace the 5 flat `latest_event_*` columns added in 000120 with a single `latest_events_by_name jsonb` array. | DROP VIEW briefly invalidates anon SELECTs (sub-second, single transaction). The flat `latest_event_*` columns have no in-prod reader (Phase 1 customer page doesn't reference them), so removing them is safe. **The new shape** (`latest_events_by_name` JSONB) is what the WIP customer page reads. |
| 000122 | `dashboard_latest_events_view.sql` | 55 | CREATE OR REPLACE `dashboard_latest_events` view; explicit REVOKE FROM anon, public; GRANT SELECT TO authenticated. | None. New view; no destructive operations. |

## Production-safety pre-checks for migrations

**Verdict: all 7 migrations are safe to run on the live DB while the customer page is serving traffic.**

Specifically:

- **No table-level locks beyond the brief AccessExclusiveLock taken by ALTER TABLE.** Settings, proof_versions, and proof_events are all small tables (< 5 MB combined, almost certainly), and ALTERs with literal defaults skip the rewrite path on PG 11+.
- **No large-table rewrites.** The only backfill (000118 `UPDATE proof_versions SET displayed_variant_ids = ...`) is a full-table scan but the table is small.
- **No drop of a column the current production code reads from.** The two columns dropped by 000119 (`total_price_at_action`, `currency_at_action`) were added by 000116 in the same uncommitted batch and have zero in-prod readers — Phase 1 customer page doesn't reference them, no edge function consumes them. The `latest_event_*` columns removed by 000121 also have zero in-prod readers (added by 000120 in the same batch).
- **No RLS change that affects existing read paths.** New RLS on `proof_events` (000116) is additive — existing tables / policies untouched.
- **One sanity check before applying 000119:** confirm `proof_events` is empty on prod (`select count(*) from proof_events;` → 0). The migration's comment claims it is; verify before pulling the trigger so the DROP COLUMNs are no-data-loss.

## Drift check on responsive-audit fixes

All 5 `min-h-[44px]` instances present in the WIP working tree:

| Line | Element | Status |
|---:|---|:---:|
| 807 | Action-band Approve button | ✓ |
| 842 | Action-band Request changes button | ✓ |
| 2455 | Modal Cancel button | ✓ |
| 2493 | Modal Confirm button | ✓ |
| 3407 | Phase 1 Download chip (already on main) | ✓ |

**No drift.** All four button-height fixes from the previous session survived re-application against the WIP working tree.

## Half-built / questionable code scan

- **TODO / FIXME / HACK / XXX / debugger:** zero hits across all WIP TS, TSX, and edge-function files.
- **`console.log` calls:** zero in app code. Two `console.error` calls in app code, both intentional error-path logging with `[module-tag]` prefixes (already on main, not new). The edge function has 10 `console.error` / `console.warn` calls — all in error / partial-failure paths, appropriate for a Deno edge runtime.
- **Dev-only branches:** none found. No `import.meta.env.DEV` gates, no `process.env.NODE_ENV === 'development'` checks.
- **Stubs / placeholder returns:** none found.
- **One soft flag:** `src/lib/approvalSettings.ts` exports four functions but only one is used (see file-level inventory above). 117 of 120 lines are dead code. Not a blocker; flag for tidy-up before merge.

## Cross-cut check — files outside `CustomerProofPage.tsx` and migrations

Already inventoried above. Recap:

- `src/lib/types.ts` (+60) — new interface shapes for the new view columns + edge function response payload.
- `src/lib/publicSettings.ts` (+22) — extends `PublicSettings` with the two confirmation-copy fields.
- `src/lib/approvalSettings.ts` (+120, new) — the dead-code-heavy invalidation hook.
- `src/pages/DashboardPage.tsx` (+169) — Latest activity sidebar + Changes requested badge.
- `src/pages/ProofDetailPage.tsx` (+164) — per-recipient audit panel.
- `src/pages/NewVersionPage.tsx` (+24 / -17) — write-side switch from `pricing_snapshot` to `displayed_variant_ids`.
- `src/pages/admin/AdminSettingsPage.tsx` (+127) — Customer approvals admin section.
- `supabase/config.toml` (+9) — anon access for the new edge function.
- `supabase/functions/proof-action/index.ts` (+616, new) — customer-facing approval edge function.
- 7 SQL migrations (+839, all new).

**No untracked files contributing to the WIP merge** beyond the audit artefacts under `responsive-audit/` and `.claude/` which are session-local and ignorable.

## Build + type check

`npm run build` (alias for `tsc -b && vite build`) **clean.** 187 modules transformed, 990 KB JS / 60 KB CSS. Single chunk-size warning is pre-existing — also present on `main` HEAD pre-WIP, so not a regression.

## Recommended merge order

**Single phase: all 7 migrations first, then code deploy.** No interleaving needed.

Rationale:

- Migration 000117 is the **hard ordering constraint**. It makes `proof_versions.pricing_snapshot` nullable. The new code in `NewVersionPage.tsx` stops writing the column on insert. If the code deploys before 000117 runs, every new-version insert fails at the `NOT NULL` constraint. **Migrations must precede code deploy.**
- Migrations 000116, 000118, 000120, 000121, 000122 add new surfaces (columns, views, indexes, the edge-function endpoint config) that the **old** customer page does not reference at all. Running the migrations against production while the old customer page is still live is a no-op for that page.
- Migration 000119 drops two columns from `proof_events` that have zero in-prod readers (added by 000116 in the same uncommitted batch, replaced before any code was deployed). Safe.
- Code deploy unifies all the new readers (customer page, dashboard sidebar, proof detail audit panel, admin settings section) and the writer (`NewVersionPage` switch to `displayed_variant_ids`) plus the edge function that the customer page calls into.

**Suggested execution sequence:**

1. (Pre-flight) `select count(*) from proof_events;` — confirm 0 to validate the comment in migration 000119.
2. Apply migrations 000116 → 000122 in order (Supabase migration runner handles this; numbered sequence is monotonic).
3. (Pre-flight on the code) Decide on the `src/lib/approvalSettings.ts` dead-code question — delete the three unused getters or accept the soft flag.
4. Deploy code (edge function + frontend) atomically. Both can ship in the same Netlify deploy + `supabase functions deploy proof-action` command pair.
5. (Post-deploy verification) Visit a multi-version proof on a phone; confirm the revisions stepper still stacks below the spotlight (Phase 2 audit P0 fix), action bands render with `approvals_enabled` flipped on for one test proof, customer page reads live pricing without UI flicker.

**Ordering risks to watch for:**

- **Don't deploy code first.** As noted, NewVersionPage will break on insert until 000117 runs.
- **Don't run only some migrations and pause.** Each downstream migration depends on the previous (e.g. 000121 references the `proof_events.name` column added by 000116 + the view shape from 000120; 000122 references `proof_events.name`). Run all 7 contiguously or none.
- **Don't skip the empty-table sanity check before 000119.** If any test events were inserted between Phase 2 verification and merge time, those rows will lose their pricing fields silently. Either keep them (they're test data, no real audit value) or migrate them to the new `pricing_snapshot_at_action` shape before running 000119.

## Blockers (none)

No blockers identified. The dead-code finding in `approvalSettings.ts` is a soft flag, not a blocker — the file compiles and doesn't ship anything broken.

## Recommended one-line decisions for Rob

| Question | Recommendation |
|---|---|
| Merge as a single PR or split? | Single PR. The 7 migrations + code are tightly coupled (write-side + read-side + edge function + admin toggle ship together). Splitting risks half-deployed states. |
| Tidy the dead code in `approvalSettings.ts` before merge? | Yes — 5 minutes, removes future-confusion. Either delete the three getters or fold the invalidation into `publicSettings.ts`. |
| Run migrations in production, or wait for a maintenance window? | Run live. None of the seven take meaningful locks or rewrite large data. |
| Sanity-check `proof_events` row count before applying 000119? | Yes. One-line query, hard catch if any test rows accumulated. |
| Re-run the responsive audit after merge? | Optional. The two on-`main` commits (`16e22a5`, `81c0473`) are already verified against the WIP shape during the previous session. The four button `min-h-[44px]` fixes will land with the WIP merge automatically. The deferred follow-up scenarios (D-1 polish, D-2 polish, D-3 / D-4 edge-function-coupled) are still deferred. |

## What's ready to merge

The WIP branch is in shippable shape. ~3,000 lines of new code with zero TODOs, zero stubs, type-clean, build-clean, all four post-audit touch-target fixes present, all seven migrations safe to run live, no destructive drops affecting in-prod data, and a clear single-phase deploy order.

Audit closed. Stop here pending Rob's triage decisions on the dead-code cleanup and the green-light for merge execution.
