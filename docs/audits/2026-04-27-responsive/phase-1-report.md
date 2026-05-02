# Customer proof viewer — responsive audit, Phase 1

**Scenario:** 1 — Single recipient, single version, no actions taken
**Proof under test:** `a04826b7-931b-4a83-98ac-2a81e625179e` (Matthew Latifi → "Oswald", v1, GBP, Stainless Steel, single image)
**Run date:** 2026-04-27
**Tooling:** preview MCP attached to local Vite dev server (port 5173) — no Playwright install

## Deviations from brief

- **Image count:** Oswald has 1 proof image (Front, no Back). The brief specified "two proof images (Front/Back)" but no real-data proof in the DB satisfies *all* of {single recipient, single version, two images, no actions}. Closest-fit candidate used; the 2-image grid layout will get exercised in scenarios 6 (Chris v3, Front+Back) or in state-hacked variants in Phase 2.
- **PNG-on-disk capture:** the preview MCP's `screenshot` tool renders images to me visually but does not expose bytes for filesystem writes. PNG screenshots referenced below were viewed in-context, not saved to disk. Findings rely on DOM measurements (which *were* saved as JSON) plus visual inspection. **Decision needed:** if you want PNGs on disk for later reference, options are (a) inject `html2canvas` and POST data URLs to a save endpoint — fragile; (b) install Playwright after all — heavier; (c) accept the in-conversation visual record as the audit trail. Phase 1 used (c).

## Executive summary

| Breakpoint | Pass / fail | Issues found |
|---|---|---|
| 360 × 640 small phone | **fail (P1)** | Pricing table right-edge clipped 8px; Download chip touch target |
| 390 × 844 modern phone | fail (P0) | Download chip touch target |
| 430 × 932 large phone | fail (P0) | Download chip touch target |
| 768 × 1024 tablet portrait | fail (P0) | Download chip touch target |
| 1024 × 768 tablet landscape | pass | none |
| 1440 × 900 laptop | pass | none |
| 1920 × 1080 wide desktop | pass | none |

**Issue counts:** 1 × P0, 2 × P1, 1 × P2, 0 × overflow violations.

**Headline:** the page chrome (masthead, hero, spec, image grid, key features, disclaimer, footer) is responsive-safe — no horizontal overflow at any breakpoint. The two layout problems that surfaced are tightly localised: a touch-target violation on the per-image **Download ↓** chip (persistent at every touch viewport), and **pricing table content spilling 8 px past its scroll wrapper at 360 px only**.

## Per-issue entries

### P0-1 — `Download ↓` chip fails 44 × 44 touch target

- **Scenario:** 1 (single recipient resting state)
- **Breakpoints affected:** 360 × 640, 390 × 844, 430 × 932, 768 × 1024 (every touch viewport)
- **Severity:** P0
- **Element:** `<a class="inline-flex shrink-0 items-center gap-1.5 rounded-full borde…">Download ↓</a>`, sits under each proof image filename caption.
- **Measurement:** 124 × **28 px** at every breakpoint. Width passes 44, height fails 44 by 16 px.
- **Description:** the inline download chip beneath each proof image is rendered as a small pill — comfortable for mouse, but on touch viewports it falls under the WCAG 2.5.5 / Apple HIG minimum. Customers on phones who want to download the proof artwork will struggle to hit it cleanly.
- **Visual reference:** screenshot in chat at 360 × 640, scrolled to the proofs section — chip sits flush under "Proof078_Front_RG.jpg".
- **Suggested fix:** bump vertical padding to give h ≥ 44, e.g. `py-2` → `py-2.5` plus `min-h-[44px]`, or wrap the link in a larger hit area with `before:absolute before:inset-y-[-8px]` extender. Single-class change, ~5 min effort.

### P1-1 — Pricing table clips 8 px on the right at 360 px viewport

- **Scenario:** 1
- **Breakpoint affected:** 360 × 640 only (clears at 390+)
- **Severity:** P1 (not P0 because the wrapper is `overflow-x-auto`, so it is *technically* swipeable — but no visible scrollbar on iOS, no horizontal-scroll affordance, so the customer reads it as broken)
- **Description:** the inner `<table>` is laid out at 320 px wide inside a `.overflow-x-auto` wrapper that is 312 px wide (parent has `px-6` = 24 px each side, so wrapper = 360 − 48 = 312). The rightmost cell — "800 MICRON" column — extends from x=269 to x=344, i.e. 8 px past the wrapper's right edge at x=336. Inner price text is positioned at the cell's right boundary, so the **last 1 character of every value in that column is clipped**: `£299` reads as `£29`, `£5.98 each` reads as `£5.9 eac`, header `800 MICRON` reads as `80 MICRO`.
- **Risk:** misreading the price. `£29` is plausible as a 50-quantity price for the cheapest variant; the customer has no visual cue that the digit "9" is hiding off-screen.
- **Visual reference:** 360 × 640 full-page screenshot in chat — pricing section, third column.
- **DOM evidence:**
  - wrapper: `clientWidth = 312, scrollWidth = 320, scrollLeft = 0` → 8 px overflow, not scrolled
  - last header cell: `l=269, r=344`, viewport visible right edge at x=336
- **Suggested fixes (pick one):**
  1. Stack pricing columns vertically below the `sm:` breakpoint — convert to a "card per row, prices listed under the qty" layout. Best UX, biggest diff.
  2. Tighten table internal padding on `<th>` / `<td>` (currently giving each thickness column 75 px) so the table fits in 312 px at 360 viewport. Smallest diff. Risk: cramped readability.
  3. Reduce the wrapper's parent padding from `px-6` (24) to `px-4` (16) below `sm:` to give the wrapper 32 px more room. Targeted fix, no table-shape change.
- **Effort:** 30–60 min for option 1; 10–20 min for options 2/3.

### P1-2 — Lightbox has no visible close affordance on touch

- **Scenario:** 1 (verified by clicking the proof image at 360 × 640)
- **Breakpoints affected:** all touch viewports (360, 390, 430, 768)
- **Severity:** P1 — backdrop click *does* close the lightbox (verified), but there is no X button and no on-screen hint. ESC key works on desktop but is unreachable on phone.
- **Description:** the lightbox renders as `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">` with a centred image. A first-time touch user has no visual cue that tapping outside the image closes it. The image is `max-h-full max-w-full object-contain`, so on a portrait phone with a landscape proof image there is plenty of tappable backdrop above and below — discoverable for some users, missable for others.
- **Visual reference:** 360 × 640 screenshot, lightbox opened.
- **Suggested fix:** add an absolute-positioned close button at top-right of the lightbox: `<button aria-label="Close" class="absolute top-4 right-4 grid h-11 w-11 place-items-center rounded-full bg-white/10">×</button>`. 44 × 44 hit area; minimum diff. Effort: 10 min.

### P2-1 — Pricing table inter-column whitespace reads unbalanced at tablet+ widths

- **Scenario:** 1
- **Breakpoints affected:** 768 × 1024, 1024 × 768, 1440 × 900, 1920 × 1080
- **Severity:** P2 polish
- **Description:** at tablet portrait and wider, the pricing table left-aligns the "TOTAL QUANTITY" label column and right-aligns each price cell within its thickness column. The label column is narrow (small text like "50", "75", "100") and the price cells are right-aligned, so each row reads as a far-left value plus three far-right values with conspicuous empty space between them. Functionally fine; visually feels uncentred — particularly at 1920 × 1080 where the whole table is centred in a 1040 px max-width container with significant viewport margin already.
- **Suggested fix:** either centre-align prices within their cells, or reduce table `max-w-` so the columns sit closer together. Subjective design choice, ask a designer. Effort: 15 min if a direction is decided.

## Touch target violations table

Scan: every `<button>`, `<a>`, `<input>`, `<textarea>`, `<select>`, `<label[for]>`, `[role="button"]` on the page. Visible elements only. `sr-only` inputs measured against their wrapping label/button.

| Breakpoint | Tag | Text / role | W × H | Pass 44 × 44? | Notes |
|---|---|---|---:|:---:|---|
| 360 × 640 | `<a>` | Download ↓ | 124 × 28 | **NO** (h fails) | image download chip |
| 360 × 640 | `<button>` | (proof image, lightbox trigger) | 312 × 269 | yes | |
| 360 × 640 | `<input type=number>` | quantity lookup | 246 × 53 | yes | |
| 360 × 640 | `<label>` | "I've read this and understand the terms" | 254 × 59 | yes | sr-only checkbox wrapped |
| 390 × 844 | `<a>` | Download ↓ | 124 × 28 | **NO** | |
| 390 × 844 | other 3 elements | | | yes | |
| 430 × 932 | `<a>` | Download ↓ | 124 × 28 | **NO** | |
| 430 × 932 | other 3 elements | | | yes | |
| 768 × 1024 | `<a>` | Download ↓ | 124 × 28 | **NO** | |
| 768 × 1024 | `<label>` | "I've read this and understand the terms" | 426 × **46** | borderline pass | scrapes 44 by 2 px |
| 768 × 1024 | other 2 elements | | | yes | |

## Overflow scan results

`document.documentElement.scrollWidth > clientWidth` at every breakpoint.

| Breakpoint | scrollWidth | clientWidth | Overflow? | Page height |
|---|---:|---:|:---:|---:|
| 360 × 640 | 360 | 360 | NO | 5425 |
| 390 × 844 | 390 | 390 | NO | 5306 |
| 430 × 932 | 430 | 430 | NO | 4991 |
| 768 × 1024 | 768 | 768 | NO | 4623 |
| 1024 × 768 | 1024 | 1024 | NO | 4763 |
| 1440 × 900 | 1440 | 1440 | NO | 4777 |
| 1920 × 1080 | 1920 | 1920 | NO | 4777 |

**No horizontal page overflow anywhere.** The pricing table's *internal* overflow (8 px past its scroll wrapper at 360 px) does not bubble up to the page level — it's contained by `overflow-x-auto`.

## Audit deferred (not reachable in Phase 1, or scope-deferred)

- **Scenarios 4, 5, 7 (multi-recipient bands, mixed states, long-name stress):** action band gates on `activeVersion.approvals_enabled`, which is `false` for every proof in the live DB. Reachable in Phase 2 via permitted React state hack — flip `approvals_enabled = true` on the loaded version object plus inject synthetic `latest_events_by_name` rows. Will be done.
- **Scenarios 8, 9 (Approve / Request Changes modal open):** same gate. Phase 2 will set `actionPanel` state directly to render the modal without firing any edge function.
- **Scenario 10 (failed-notification banner):** deferred per Rob's call. The visual hinges on a `latest_events_by_name` row with `helpscout_thread_id: null`, written by the `proof-action` edge function on partial-failure. Scaffolding a representative shape via state hack is possible but the layout will be far more meaningful once a real customer round-trip lands a failed thread. Re-audit after the first end-to-end trial.
- **Transition variants of scenarios 2 and 3 (post-approval / post-changes-requested fresh-state animations):** deferred per Rob's call. The "optimistic" state transitions involve banners that appear immediately after a button click, then settle when the server confirms. Hard to audit cleanly without firing the edge function. Re-audit after a real customer walk-through.

## Incidental findings

- **Console:** no errors or warnings on any breakpoint. Only Vite HMR debug noise and the standard "Download the React DevTools" dev hint.
- **Image lightbox dismissal:** discoverability issue noted as P1-2 above; this also flirts with a11y. There is a keydown listener for ESC (line 89), but no `role="dialog"` / `aria-modal="true"` / `aria-label` on the backdrop, no focus trap, and no focus-restoration on close. Worth a follow-up a11y pass — out of scope for this layout audit.
- **Disclaimer label:** at tablet portrait (768 × 1024) the "I've read this and understand the terms" label measures 426 × **46** px — clears the 44-px minimum by 2 px. On browser zoom or any future font-size bump, this will fail. Worth tightening to a stable ≥ 48 with a `min-h-[48px]`.
- **Page heights:** scrollHeight collapses from 5425 px at 360 to 4777 px at 1440+. The variance is concentrated in the "About our stainless steel cards" key-features list (one column → multi-column at wider widths) and the disclaimer block (long paragraph reflow). All within expected reflow behaviour.

## Prioritised fix list

| # | Severity | Issue | Suggested fix | Effort |
|---|:---:|---|---|:---:|
| 1 | P0 | `Download ↓` chip 28 px tall on touch | Add `min-h-[44px]` + bump vertical padding | 5 min |
| 2 | P1 | Pricing table clips 8 px on 360 px viewport | Reduce parent `px-6 → px-4` below `sm:`, *or* stack columns vertically below `sm:` | 15–60 min |
| 3 | P1 | Lightbox has no visible close on touch | Add `absolute top-4 right-4` close button, 44 × 44, with `aria-label="Close"` | 10 min |
| 4 | P2 | Pricing table whitespace unbalanced at tablet+ | Centre-align cell content or reduce table max-width — needs design call | 15 min |
| 5 | follow-up | Lightbox a11y (no role/dialog, no focus trap) | Add `role="dialog" aria-modal="true"` + focus trap + focus restore | 30 min |
| 6 | follow-up | Disclaimer label borderline 46 px on tablet | `min-h-[48px]` to keep it stably above 44 | 5 min |

**Recommended P0/P1 batch for this session:** items 1, 2, 3 — all small, additive, no risk to the in-flight approval flow. Total ~30–80 min.

## Decisions for Rob before Phase 2

1. **PNG-on-disk vs in-conversation visual record.** Phase 1 used the latter. If Phase 2 + later passes want PNGs saved, the cleanest way is to install `playwright` after all — `npx playwright install chromium` is ~170 MB. Cheaper alternative: inject `html2canvas` from a CDN at audit time and POST data URLs to a small dev-time write endpoint, but it's more moving parts.
2. **Format check.** Is this report format (executive summary table → per-issue entries → scan tables → deferred → incidental → prioritised fix list) what you want, or should I restructure before scaling to Phase 2 across the remaining ~6 reachable scenarios?
3. **Phase 2 scope confirmation.** Plan is: scenarios 1 (post-action variants), 4, 5, 6, 7, 8, 9 across all 7 breakpoints, using state hacks where needed (per the granted permission). Each per-issue entry will include a one-liner stating the React state injection used. Confirm or redirect.
