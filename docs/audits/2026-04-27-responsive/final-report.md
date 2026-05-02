# Customer proof viewer — responsive audit, Phase 1 + Phase 2 (closed)

**Tooling:** preview MCP attached to local Vite dev server (port 5173) — no Playwright install.
**Branch state at close:** `main` carries two audit-fix commits (`16e22a5`, `81c0473`); the WIP multi-recipient approval flow remains uncommitted in the working tree, with one additive change applied on top (the four `min-h-[44px]` button class strings) that travels with the WIP branch.
**Run dates:** 2026-04-27. Phase 1 fixes + audit + Phase 2 audit + remaining P0 fixes + verification all in one session.
**Status: closed.** All three P0s resolved. P1 polish + the deferred edge-function-coupled scenarios are recorded for follow-up.
**Confidence tags on findings:** **durable** = on HEAD code, will not shift; **may-shift-on-refactor** = on the in-flight approval flow, may move when that code is finalised.

## Tooling deviations from brief

- **PNG-on-disk capture:** the preview MCP's `screenshot` tool renders images visually but does not expose bytes for the `Write` tool. PNGs were not saved to disk. Visual record sits in the chat transcript; per-breakpoint DOM-measurement JSONs are in `responsive-audit/scenario-1/`. Decision was locked early — revisit only if a long-term archive is ever needed.
- **Image count on Phase 1 baseline (Oswald):** brief specified 2 images, real proof has 1. Closest-fit candidate; the 2-image grid was exercised in scenario 6 on the Chris proof.

## State injection used (Phase 2)

The customer page's `approvals_enabled` flag is `false` for every proof in the live DB, so action bands and modals don't render on real data. Per the granted state-hack permission, I installed a `window.__audit` helper that walks the React fiber tree, finds the `CustomerProofPage` component, and dispatches its `useState` setters directly. Each per-issue entry below includes a one-liner stating the injection used. No DB writes were made.

## Executive summary

### Pre-fix state (what the audit found)

| Breakpoint | Status | P0 | P1 | P2 |
|---|---|---:|---:|---:|
| 360 × 640 small phone | fail | 3 | 1 | 1 |
| 390 × 844 modern phone | fail | 3 | 0 | 0 |
| 430 × 932 large phone | fail | 3 | 0 | 0 |
| 768 × 1024 tablet portrait | fail | 2 | 0 | 0 |
| 1024 × 768 tablet landscape | fail | 2 | 0 | 0 |
| 1440 × 900 laptop | fail | 2 | 0 | 0 |
| 1920 × 1080 wide desktop | fail | 2 | 0 | 0 |

### Post-fix state (verified at close)

All three P0s resolved. P1 + P2 polish deferred per agreed scope. Remaining failures are recorded under "deferred to follow-up" and stem from edge-function-coupled scenarios that require a real customer round-trip to audit accurately.

| Breakpoint | Status | Open P0 | Open P1 | Open P2 |
|---|---|---:|---:|---:|
| 360 × 640 small phone | pass for the audited surface | 0 | 1 (deferred) | 1 (deferred) |
| 390 × 844 modern phone | pass | 0 | 0 | 0 |
| 430 × 932 large phone | pass | 0 | 0 | 0 |
| 768 × 1024 tablet portrait | pass | 0 | 0 | 0 |
| 1024 × 768 tablet landscape | pass | 0 | 0 | 0 |
| 1440 × 900 laptop | pass | 0 | 0 | 0 |
| 1920 × 1080 wide desktop | pass | 0 | 0 | 0 |

## Resolved findings

### R-1 — Download chip touch target *(Phase 1 fix, durable)*

- **Original measurement:** 124 × **28 px** at every touch viewport.
- **Fix:** added `min-h-[44px]` to the chip class string in `PlateCard`.
- **Verified:** 124 × 44 at 360 / 390 / 430 / 768. No regression at desktop sizes (chip clamps to 44 floor; content centres via existing `inline-flex items-center`).
- **Commit:** `16e22a5` — `customer page: responsive fixes for download chip, pricing table, lightbox close`.

### R-2 — Pricing table 8 px overflow at 360 *(Phase 1 fix, durable)*

- **Original measurement:** wrapper `clientWidth = 312, scrollWidth = 320` at 360 viewport. Rightmost column clipped — `£299` rendered as `£29`, `£5.98 each` as `£5.9 eac`.
- **Fix:** tightened cell horizontal padding to `pr-2 sm:pr-4 / pl-2 sm:pl-4` on the multi-variant table, freeing 32 px of column width below `sm:` while preserving desktop spacing.
- **Verified:** wrapper `scrollWidth === clientWidth = 312` at 360. Full price values render. No change at sm+ where the original `pr-4 / pl-4` padding still applies.
- **Commit:** `16e22a5`.

### R-3 — Lightbox close affordance on touch *(Phase 1 fix, durable)*

- **Original state:** lightbox dismissed by backdrop tap only — no visible close button, no on-screen hint.
- **Fix:** added an absolute-positioned `<button aria-label="Close">` at top-right of the lightbox backdrop, 44 × 44, with hover and focus-visible states.
- **Verified:** 44 × 44 at 360 with `aria-label="Close"`. Click dismisses. ESC dismissal (existing) still works. Backdrop click (existing) still works.
- **Commit:** `16e22a5`.

### R-4 — Revisions stepper overflowing viewport at phone widths *(Phase 2 fix, durable)*

- **Original measurements:** 360 viewport produced `scrollWidth = 456` (96 px page overflow); 390 → 67 px overflow; 430 → 27 px overflow. Right arrow `›` rendered at `r=457`, partially or wholly off-screen.
- **Diagnosis:** `RevisionsBand` rendered a 2-column grid (`grid-template-columns: auto 1fr`) at every viewport. At 360 the spotlight column took ~152 px (`min-w-[120px]` + `pr-8`), the gap took 32 px, leaving ~128 px for the rail column. The narrow / stepper mode in `RevisionsTimeline` needs ~297 px to fit (`44 + 16 + 177 + 16 + 44`), so it overflowed the column by ~169 px and the page by 96 px.
- **Fix:** stack the band vertically below `sm:` (spotlight on top, rail below) so the rail gets full content width on phones, and switch to the original 2-column layout at `sm:+`. Spotlight's `min-w-[120px]`, `pr-8`, and right-hand hairline border become `sm:`-only — they're column-layout artefacts that don't apply when stacked.
- **Verified across 360 / 390 / 430:** `de.scrollWidth === de.clientWidth` (no horizontal page overflow); right arrow `›` at `r=336 / 366 / 406` (well within viewport in each case). At 768+ the original 2-column layout still renders correctly.
- **Commit:** `81c0473` — `customer page: stack revisions band vertically on phone widths`.

### R-5 — Action band Approve / Request Changes buttons fail 44 h *(Phase 2 fix, may-shift)*

- **Original measurements:** Approve = 41 h, Request changes = 43 h, at every viewport on every multi-recipient scenario (4, 5, 7).
- **Fix:** added `min-h-[44px]` to both button class strings in `renderActionBand`. Same pattern as the Phase 1 download chip fix.
- **Verified at 360 (3 recipients pending):** all 6 buttons (3 × Approve + 3 × Request Changes) at 44 h, zero violations. Verified at 768: same 6 buttons, all 44 h. The `min-h` is a floor — buttons clamp to 44 minimum at every viewport, no desktop regression possible.
- **Lives on the WIP branch** (no commit to main). Travels with the multi-recipient approval flow when that branch merges.

### R-6 — Modal Cancel / Confirm buttons fail 44 h *(Phase 2 fix, may-shift)*

- **Original measurements:** Cancel = 43 h, Confirm = 41 h, in both Approve and Request Changes modals, across all 5 captured viewports (360, 390, 430, 768, 1440).
- **Fix:** added `min-h-[44px]` to both button class strings in the action confirmation modal.
- **Verified at 360:** Cancel 270 × 44, Confirm 270 × 44, in both Approve and Request Changes modal types. Verified at 768: Cancel 104 × 44, Confirm 111 × 44. Zero violations.
- **Lives on the WIP branch** (no commit to main). Same merge story as R-5.

## Touch target violations table — final state

Visible interactive elements at every audited viewport. Post-fix.

| Breakpoint | Element | Pre-fix | Post-fix | Pass 44 × 44? |
|---|---|---:|---:|:---:|
| 360 × 640 | Download ↓ chip | 124 × 28 | 124 × **44** | yes |
| 360 × 640 | Action-band Approve {recipient}'s design | 312 × 41 | 312 × **44** | yes |
| 360 × 640 | Action-band Request changes | 312 × 43 | 312 × **44** | yes |
| 360 × 640 | Modal Cancel | 367 × 43 | 270 × **44** | yes |
| 360 × 640 | Modal Confirm | 367 × 41 | 270 × **44** | yes |
| 360 × 640 | Lightbox Close (added in R-3) | — | 44 × 44 | yes |
| 360 × 640 | Disclaimer label "I've read this..." (label wrap) | 254 × 59 | 254 × 59 | yes (unchanged) |
| 768 × 1024 | Action-band Approve (sm: side-by-side) | 237 × 41 | 237 × **44** | yes |
| 768 × 1024 | Action-band Request changes | 185 × 43 | 185 × **44** | yes |
| 768 × 1024 | Modal Cancel | 104 × 43 | 104 × **44** | yes |
| 768 × 1024 | Modal Confirm | 111 × 43 | 111 × **44** | yes |

**No remaining 44 × 44 violations on the audited surface.**

## Overflow scan results — final state

| Breakpoint | Single-version proof | Multi-version proof | Notes |
|---|:---:|:---:|---|
| 360 × 640 | clean | **clean (was 96 px)** | Stepper now stacks below spotlight |
| 390 × 844 | clean | **clean (was 67 px)** | |
| 430 × 932 | clean | **clean (was 27 px)** | |
| 768 × 1024 | clean | clean | Original 2-column layout still in play at sm+ |
| 1024 × 768 | clean | clean | |
| 1440 × 900 | clean | clean | |
| 1920 × 1080 | clean | clean | |

**Zero horizontal page overflow at every breakpoint, on every audited proof shape.**

## Deferred to follow-up

Items below are not bugs that block close-out — they're issues the agreed scope intentionally pushed past this session. Captured here so the trade-off is preserved.

### Deferred polish — recorded, not chased this session

- **D-1 *(P1, may-shift)* Long-name heading wraps mid-hyphen at 360.** "Christopher Featherstone-Haugh" splits as "Christopher Featherstone-" / "Haugh" because browsers default to treating hyphen as a soft-break opportunity. Suggested fix: `word-break: keep-all; overflow-wrap: anywhere` on the band heading, or replace hard hyphens with non-breaking hyphen U+2011 at format time. Pure polish; readable as-is. Effort: 15 min.
- **D-2 *(P2, may-shift)* Approve button label wraps to 2 lines on long names at narrow phones.** With "Approve Christopher Featherstone-Haugh's design" the button stretches from 41 h to 57 h at 360 / 390 / 430 and looks visually heavier than other bands' buttons. Now that R-5 floors the button at 44 h, the inconsistency persists at narrow widths only. Fix would involve a fixed `h-11` plus label truncation, or accepting variable-height buttons. Subjective design call.

### Deferred scenarios — pending real customer round-trip

- **D-3 — Scenario 2 / 3 optimistic transition states.** The action band's `optimistic` branch (`getBandState` line 577–585) renders a banner immediately after a button click and includes a `successMessages[key]` line whose copy comes from the `proof-action` edge function response. State-hacking the optimistic banner now would mock that response shape and audit the mock; the real shape is in flight on the same WIP branch. Re-audit after the first end-to-end customer walk-through.
- **D-4 — Scenario 10 failed-notification banner.** The banner gates on `latest_events_by_name[*].helpscout_thread_id === null`, written by the edge function on a partial-success path (event recorded, Help Scout post failed). The visual hinges on server-side semantics that can only be exercised by an actual partial-failure round-trip. Re-audit alongside D-3 after the first real partial-failure event.

All four deferred items will be re-evaluated together once the edge function has had at least one customer go end-to-end.

## Incidental findings

- **Console clean across all scenarios and breakpoints during both audit passes** — no errors or warnings. Only Vite HMR debug noise + the standard "Download the React DevTools" hint.
- **Lightbox a11y is still thin (carried from Phase 1).** The Phase 1 fix added a visible close button and `aria-label="Close"`, but the dialog is still missing `role="dialog"`, `aria-modal="true"`, focus trap, and focus restoration on close. Out of scope for this responsive audit — flagged as a follow-up.
- **Disclaimer label borderline at tablet portrait (carried from Phase 1).** At 768 the "I've read this and understand the terms" label is 426 × **46** px — clears 44 by 2. A `min-h-[48px]` would harden it against future zoom or font-size bumps. Same a11y bucket as above.
- **`window.innerWidth` vs `matchMedia` mismatch in the preview MCP** — `innerWidth` returned 456 / 457 even when the preview viewport was set to 360 / 390 / 430, particularly after `window.location.href` navigation. `matchMedia` returned the correct booleans and DOM measurements were consistent with the requested viewport. Tooling quirk, not a finding on the page itself; recorded so future audits aren't tripped by it.
- **Page heights scale predictably with recipient count** — 5400 px at 1 recipient, 7200 px at 3 recipients, 9000 px at 5 recipients. No layout-collapse or reflow oddity.
- **Multi-recipient bands have clear visual separation** at every breakpoint — horizontal-rule dividers between each named group, no risk of bands reading as one continuous block.

## Audit history (commits and changes)

| Commit | What changed | Lives where |
|---|---|---|
| `16e22a5` | Phase 1: Download chip min-h, pricing table cell padding, lightbox close button | `main` |
| `81c0473` | Phase 2: revisions band stacks vertically below sm: | `main` |
| (uncommitted, in WIP working tree) | min-h-[44px] on action-band Approve, Request changes; modal Cancel, Confirm | travels with the WIP multi-recipient branch |

Both `main` commits are tightly scoped responsive fixes with no behavioural change. The WIP-branch addition is similarly additive — pure CSS class change, no logic touched.

## Closing note

Audit closed. Three P0s resolved, two P1/P2 items recorded as deferred polish, two scenarios + one variant pair recorded as pending the first real customer round-trip. Touch-target scan and overflow scan both come back clean across all 7 breakpoints on the audited surface. No further work to take in this session without explicit direction.
