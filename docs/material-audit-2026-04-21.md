# Material-specific logic audit — 2026-04-21

## Executive summary

The codebase is much more data-driven than "hardcoded per-material" in the usual sense. There are **zero** places where the code branches on a specific material code (`metal_steel`, `paper_letterpress`, etc.) to change behaviour — every such decision goes through the `materials.variant_type` enum or one of three flags (`requires_ink_names`, `featured_quantities`, `option_label`). The real couplings are:

- The `variant_type` enum is treated as a closed set of four values (`thickness` / `ink_count` / `finish` / `default`) in three places.
- The ink-names UI is a hard binary: N labelled required fields vs one optional comma-separated field, gated by the `requires_ink_names` flag. A third shape would need code.
- `thickness` is privileged: it's the only variant_type where a single proof can expose several variants at once.
- Three identical `DEFAULT_FEATURED = [100, 250, 500, 750, 1000]` constants are duplicated across three files.

Total: ~8 non-trivial coupling points and 3 trivial fallbacks/duplications. Concentrated almost entirely in `NewVersionPage.tsx` and its edit counterpart; the customer-facing page and the rest of the app are already data-driven.

---

## Per-area findings

### 1. Add version form — `src/pages/NewVersionPage.tsx`

| # | Location | Behaviour | Assumption | Difficulty |
|---|---|---|---|---|
| 1 | L166 — `if (v[0]?.variant_type === 'thickness')` | Auto-selects **all** variants when the material uses thickness; otherwise single-selects. | `thickness` is the only variant_type where a proof offers multiple variants together. | Moderate |
| 2 | L513 — `const isThickness = variantType === 'thickness'` | Flag used further down to swap variant UI. | Same as #1. | Trivial (derived) |
| 3 | L654–693 — variant section | Multi-select pill group vs single-select dropdown based on `isThickness`, plus a thickness-only helper text `"— select all to expose on the proof"`. | Same as #1. Also assumes the "expose multiple to the customer" UX is only valid for thickness. | Moderate |
| 4 | L738–779 — ink names field | Entirely branches on `requiresInkNames`: N labelled required inputs vs one optional comma-separated field. | Only two ink-input shapes exist. | Moderate |
| 5 | L556–569 — `handleMaterialChange` | On material change, migrates ink data between the array and comma-separated shapes. | Same binary ink-shape assumption. | Trivial (follows #4) |
| 6 | L1041–1046 — `variantLabel()` switch | Maps `variant_type` values to human labels (`thickness`→"Thickness", etc.) with a fallback to `"Variant"`. | Closed set of four `variant_type` values. | Trivial |
| 7 | L428 — snapshot builder | `variant.variant_type === 'default' ? 'Default' : variant.display_name` — hardcodes "Default" as the display string for single-variant materials in the pricing snapshot. | Single-variant materials deserve the literal "Default" as their stored display label. | Trivial |
| 8 | L22 — `const DEFAULT_FEATURED = [100, 250, 500, 750, 1000]` | Fallback when `materials.featured_quantities` is null. | The five-tier set is a safe global fallback. | Trivial (duplicated — see Shared patterns) |

### 2. Edit version form — `src/pages/EditVersionPage.tsx`

| # | Location | Behaviour | Assumption | Difficulty |
|---|---|---|---|---|
| 9 | L62, L131 — `DEFAULT_FEATURED` | Same duplicated constant. | — | Trivial |
| 10 | L56 — `useState('Finish')` for `optionLabelSingular` | Defaults to `'Finish'`. | A reasonable default when the material has options but no `option_label` set. | Trivial |
| 11 | L118–125 — same ink-shape branching as #4 on load | Mirrors NewVersionPage's binary ink UI for pre-populating existing versions. | Same as #4. | Trivial (follows #4) |

### 3. Customer-facing proof page — `src/pages/CustomerProofPage.tsx`

| # | Location | Behaviour | Assumption | Difficulty |
|---|---|---|---|---|
| 12 | L201 — `optionLabelSingular = activeVersion?.option_label ?? 'Finish'` | Fallback to `'Finish'` in three user-visible places: the SPECIFICATION item label, the "Prices shown for X finish" subtitle, and the image-option tab copy. | When `option_label` is null but `material_options` exists, 'Finish' is a safe universal word. | Trivial |

No other material-specific rendering. The About / Specification / Pricing blocks all read from the `public_proof_versions` view or the `material_options` view — nothing branches on a specific material.

### 4. Proof detail page — `src/pages/ProofDetailPage.tsx`

Clean. Reads `material_display` + `ink_names` from `proof_versions` and renders them. No branching.

### 5. Proofs home + Recent Projects — `src/pages/DashboardPage.tsx`

Clean. `material_display` is read from `proof_versions` (snapshot column, synced by the rename trigger). No branching.

### 6. Shared components

| # | Location | Behaviour | Assumption | Difficulty |
|---|---|---|---|---|
| 13 | `src/components/VersionDetailModal.tsx` L33 | Third copy of `DEFAULT_FEATURED = [100, 250, 500, 750, 1000]`. | — | Trivial |
| — | `src/components/PricingDisplay.tsx` | Branches on `variants.length === 1` vs many. Driven entirely by `pricing_snapshot.variants` — not material-specific. | — | n/a |
| — | `src/components/ImageGrid.tsx` | Reads `material_option` column but doesn't branch on values. | — | n/a |
| — | `src/lib/labels.ts::pluralLabel` | Heuristic plural rule for `option_label`. String-shape driven, not material-specific. Handles the current set ("Finish"→"Finishes", "Species"→"Species", "Cutting"→"Cuttings"). | Plural rule for short labels is covered by three suffix cases. | Trivial |

### 7. Admin material editor (pricing)

Out of scope per the prompt, noted for completeness: `AdminMaterialEditor.tsx` L207 branches on `variant_type === 'default'` to render a single grid vs variant-tab strip. Same closed-set assumption as #6. Already data-driven.

### 8. Admin material content editor (settings)

Out of scope — just added, clean by design.

---

## Shared patterns

**A. `DEFAULT_FEATURED` duplicated three times.** Same exact `[100, 250, 500, 750, 1000]` array in `NewVersionPage.tsx`, `EditVersionPage.tsx`, and `VersionDetailModal.tsx`. Consolidate into a single constant in `src/lib` (or drop it by seeding every material's `featured_quantities` with a value).

**B. `variant_type` as a closed enum.** Four values (`thickness` / `ink_count` / `finish` / `default`) referenced in:
- Variant-multi-select decision (thickness only) — `NewVersionPage.tsx`
- Human label mapping — `NewVersionPage.tsx::variantLabel`
- "Default" display string in pricing snapshot — `NewVersionPage.tsx`
- Single-grid vs variant-tabs branch — `AdminMaterialEditor.tsx`

Each of the five hits is independent — no shared helper — but each assumes the enum is complete.

**C. Binary ink-input UI.** `requires_ink_names` toggles between two incompatible UI shapes in three places (NewVersionPage × 2 + EditVersionPage). The DB flag is scalar; a third shape needs new code in all three.

**D. The privilege of thickness.** Multi-variant proofs are only possible with `variant_type = 'thickness'`. Nothing else (plastic 4-ink proofs, finish-based paper proofs) offers multi-select at the variant axis. This is encoded in the frontend, not the DB — a non-thickness material seeded with several variants would quietly show as single-select on the Add version form.

---

## Surprises

1. **No slug-based branching anywhere.** Searched exhaustively for `letterpress`, `metal_steel`, `paper_*`, `plastic_*`, `carbon_*`, `wood`, `acrylic` — every hit is either (a) a seed/migration comment explaining *why* a row exists, (b) a placeholder string in an input (`"e.g. Pantone 185 C"`), or (c) a comment describing historical context.
2. **The customer page is impressively clean.** I expected material-specific section headers or pricing-column-header quirks and found none. All material-facing copy reads through `option_label`, `material_display`, and the `description` + `icon_url` fields added yesterday.
3. **The `variant_type='default'` branch in the pricing snapshot** (`NewVersionPage` L428) overrides the variant's actual `display_name` with the literal string `"Default"`. That means pricing snapshots for wood/carbon/acrylic proofs always show "Default" as the variant label on the customer page, not the material's display name. Might be intentional (the variant IS the material for those), but worth re-examining.
4. **No abandoned or obsolete material branches.** Grepping for CMYK, old status flags, and the now-renamed finish table turned up nothing in application code — everything was cleaned up at migration time.
5. **No material-specific validation rules** beyond ink-name required-ness. No "must have X images for letterpress", no "carbon fibre requires CNC option", etc.

---

## Phase 2 effort estimate

**Small — roughly half a day.**

Reasoning: the app is already mostly data-driven. The actual refactor work is a small set of targeted cleanups:

| Task | Effort |
|---|---|
| Consolidate `DEFAULT_FEATURED` into `src/lib/constants.ts` and import from 3 call sites | 5 min |
| Move `variantLabel()` into shared lib; use in both NewVersion and EditVersion | 10 min |
| Replace `variant_type === 'thickness'` with a proper `multi_variant` boolean on `materials` (migration + backfill + frontend swap) | 1–2 hours |
| Seed every material's `option_label` with a sensible value so the `'Finish'` fallback never fires; drop the fallback | 15 min |
| (Optional) Replace `requires_ink_names` boolean with an enum (`per_ink_labelled` / `comma_separated` / `none`) to leave room for a third shape | 1 hour |

Everything above is low-risk. No existing test data breaks, no customer-visible change unless Rob wants to re-flag a material. If the stretch goal of generalising the ink-input UI isn't in scope, this is closer to a **two-hour** job.

The only thing that would push this to medium is if a new material type (e.g. "holographic foil with a pattern picker") lands during the refactor and needs a third UI shape built from scratch — but that's new-feature work, not generalisation.
