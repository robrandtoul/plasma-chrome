# Material rows 1–18 — customer page sweep — 2026-05-10

Full browser verification of all 18 material rows from the test matrix playbook. Fixtures seeded via Supabase REST (service role) in the same session using `seed_material_rows.py`. Each proof was visited on the local dev server (`localhost:5173`) as an unauthenticated customer.

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 1  | pass | Steel 800µm GBP: Natural tab default, Mirror tab bakes +£30 surcharge into grid |
| 2  | pass | Steel 500µm EUR split-2: Brushed "+30 €" tab, "1 extra name × 39 €" tooling, Alice + Bob |
| 3  | pass | Gold 800µm USD: Mirror "+$30" tab, USD pricing, no VAT |
| 4  | pass | Copper GBP custom-quote: pricing grid absent, custom-quote panel renders |
| 5  | pass | Gun Metal GBP: qty 750 = £1,799 (000146 reconcile confirmed) |
| 6  | pass | Translucent 1-ink GBP: "Pantone 287" shown in spec INK COLOURS |
| 7  | pass | Tinted 2-ink EUR split-3: both inks shown, "2 extra names × 39 €" tooling |
| 8  | pass | Satin 3-ink USD: all three inks shown, USD pricing |
| 9  | pass | Full Colour GBP split-2: "1 extra name × £15" tooling |
| 10 | pass | Wood Black Walnut GBP: SPECIES label, Bamboo tab with no surcharge suffix |
| 11 | pass | Wood Bamboo EUR: Bamboo as active default, Black Walnut tab, no surcharge suffix |
| 12 | pass | Standard Paper UV Spot GBP: "With UV Spot" in spec (variant-based, not option-based) |
| 13 | pass | Standard Paper Foiling USD: "With Foiling" in spec, fewer qty tiers |
| 14 | pass | Letterpress 1-ink GBP: Colorplan cross-section renders (Front/Core: China white, Back: Adriatic) |
| 15 | pass | Gilded Letterpress 2-ink EUR split-2: distinct material, Colorplan, "1 extra name × 39 €" |
| 16 | pass | Acrylic GBP: pricing renders, no option switcher |
| 17 | pass | Carbon Fibre USD: single-variant, no option dimension (post-000098) |
| 18 | pass | Carbon Fibre with CNC GBP: distinct material (post-000098 split), own price tiers |

No bugs found. One playbook discrepancy noted (see below).

---

## Fixtures seeded (2026-05-10)

All 18 proofs linked to contact Johnny Appleseed (`866b7c84-a1d5-424b-9c73-b30aed148396`), `created_by` designer Rob (`59205cfa-c2fc-4113-b923-c705655e0ea2`). Every proof carries `internal_notes = "[QA-fn] Row N — ..."` and `helpscout_override_reason = "QA fixture — no real HS conversation"` to satisfy the `proofs_helpscout_link_or_override_chk` constraint. All share the same placeholder image (`c4529c21-cd88-43af-adf9-0b20e6cfef14/146fed7a-10f5-4600-8c22-0898c9133c57.jpg`).

| Row | Proof ID | Version ID | Material | Variant | Currency |
|-----|----------|------------|----------|---------|----------|
| 1 | e8f6cc08 | 144362a4 | Steel | 800µm | GBP |
| 2 | 3a0c3a15 | ce2f71d2 | Steel | 500µm | EUR |
| 3 | 7fef4e04 | dab3992c | Gold | 800µm | USD |
| 4 | bc690827 | 006c88a7 | Copper | 800µm | GBP |
| 5 | 56101199 | f3e32d68 | Gun Metal | 800µm | GBP |
| 6 | 00db8dc5 | eff44ae9 | Translucent | 1-ink | GBP |
| 7 | d98c9b37 | 9e509edc | Tinted | 2-ink | EUR |
| 8 | c638c376 | c9a0b687 | Satin | 3-ink | USD |
| 9 | 1b1bee85 | 494d6308 | Full Colour | 420µm | GBP |
| 10 | 6d0d94a7 | 746a892a | Wood | default | GBP |
| 11 | 482a086a | 6366ece4 | Wood | default | EUR |
| 12 | 9eec151a | 2c8eaaa8 | Standard Paper | uv_spot | GBP |
| 13 | 8f3f632e | beb2a2d9 | Standard Paper | foiling | USD |
| 14 | 6643a866 | 0226dcbc | Letterpress | 1-ink | GBP |
| 15 | c566350e | 171bc88d | Gilded Letterpress | 2-ink | EUR |
| 16 | f22f1ad9 | 5a1bd877 | Acrylic | default | GBP |
| 17 | 7ce424d4 | 02986a74 | Carbon Fibre | default | USD |
| 18 | e6135043 | 38adc704 | Carbon Fibre CNC | default | GBP |

---

## Detailed findings

### Row 1 — Metal Steel 800µm Mirror GBP single

Proof: `e8f6cc08-d262-4d02-8c83-97bc75edf705`

- Natural tab (default): "PRICES SHOWN FOR NATURAL FINISH", GBP, VAT included. Qty 50 = £299. ✅
- Mirror tab: "PRICES SHOWN FOR MIRROR FINISH", qty 50 = £329 (+£30 baked in). ✅
- Option switcher renders with "MIRROR FROM +£30" suffix. ✅
- Specification updates to "FINISH: Mirror" when Mirror tab is active. ✅
- Single name shown as "—" in header badge. ✅

### Row 2 — Metal Steel 500µm Brushed EUR split-2

Proof: `3a0c3a15-58bc-44f7-8613-ec7423546e81`

- Natural tab (default): EUR pricing, no VAT note. ✅
- Brushed option tab renders as "BRUSHED FROM +30 €". ✅
- Header: "PROOFS FOR / NAMES: Alice + Bob", "1 UNIQUE PROOF · 2 PEOPLE". ✅
- Specification: NAMES ON CARD: Alice, Bob. ✅
- Split-name tooling section: "1 extra name × 39 € tooling". ✅
- Status: "PENDING REVIEW — Approved automatically once every recipient approves their design." ✅

### Row 3 — Metal Gold 800µm Mirror USD single

Proof: `7fef4e04-8767-4019-8cbb-3b6bf9373078`

- Material: Gold. FINISH: Natural (default). Mirror tab "FROM +$30". ✅
- USD pricing, no VAT note. ✅
- Qty 50 = $399. Single name "—". ✅

### Row 4 — Metal Copper 800µm Natural GBP custom-quote

Proof: `bc690827-f383-4313-832b-3254bcef1da9`

- No pricing grid rendered. Custom-quote panel text: "This proof requires a custom quote. We'll be in touch separately with pricing." ✅
- No option switcher (no material_options). No FINISH in header badge. ✅
- No VAT footer (expected — custom quote suppresses pricing section). ✅

### Row 5 — Metal Gun Metal 800µm Natural GBP single

Proof: `56101199-78d5-4f63-a56f-7790f8f9eae8`

- GBP, VAT included. No option switcher (Gun Metal has no material_options). ✅
- Qty 750 = £1,799 — confirming the 000146 reconcile (which reset the live value back to the canonical seed). ✅

### Row 6 — Plastic Translucent 1-ink GBP single

Proof: `00db8dc5-88b7-4ef0-8f64-63cfb2ef2a77`

- Material: Translucent Plastic. INK COLOURS: Pantone 287. ✅
- GBP, VAT included. No option switcher. ✅
- Pricing tiers start at qty 100 (different featured_quantities from metal). ✅

### Row 7 — Plastic Tinted 2-ink EUR split-3

Proof: `d98c9b37-7fcd-4510-a79d-67d50b059c8c`

- Material: Tinted Plastic. INK COLOURS: Pantone 287, Pantone 485 (both shown). ✅
- Header: "NAMES: Alice + Bob + Carol", "1 UNIQUE PROOF · 3 PEOPLE". ✅
- Specification: NAMES ON CARD: Alice, Bob, Carol. ✅
- Split-name tooling: "2 extra names × 39 € tooling" = 78 €. ✅
- EUR, no VAT note. ✅

### Row 8 — Plastic Satin 3-ink USD single

Proof: `c638c376-9b10-4df9-bdde-60c71d6d0547`

- Material: Satin Plastic. INK COLOURS: Pantone 287, Pantone 485, Pantone Gold (all three shown). ✅
- USD, no VAT note. Single name "—". ✅

### Row 9 — Plastic Full Colour 420µm GBP split-2

Proof: `1b1bee85-481b-498a-b4ea-f5f348adb18f`

- Material: Full Colour Plastic. No ink names shown (CMYK, no per-ink labelling). ✅
- GBP, VAT included. "1 UNIQUE PROOF · 2 PEOPLE". ✅
- Split-name tooling: "1 extra name × £15 tooling". ✅ (£15 full-colour rate, not the £25/€39 plastic rate)

### Row 10 — Wood Black Walnut GBP single

Proof: `6d0d94a7-9b07-498d-8107-c8f0b54ebd75`

- Material: Wood. Header badge label: SPECIES (not FINISH). ✅
- Option switcher: BLACK WALNUT (active) and BAMBOO — no "+from" suffix on either. ✅
- Specification: SPECIES: Black Walnut. ✅
- GBP, VAT included. No split-name tooling. ✅

### Row 11 — Wood Bamboo EUR single

Proof: `482a086a-1095-48db-b541-5d9b0689b8fa`

- Material: Wood. SPECIES: Bamboo (first in material_options array, correctly active by default). ✅
- Option switcher: BAMBOO (active), BLACK WALNUT — no surcharge suffix on either tab. ✅
- EUR, no VAT note. ✅

### Row 12 — Standard Paper UV Spot GBP single

Proof: `9eec151a-a7af-4c4f-99ee-749e69fbe8da`

- Material: Standard Paper. FINISH in spec: "With UV Spot". ✅
- No option switcher (finish is variant-based, not material_options). ✅
- GBP, VAT included. ✅

### Row 13 — Standard Paper Foiling USD single

Proof: `8f3f632e-fdd1-486a-8c2e-3b8313e5da63`

- Material: Standard Paper. FINISH in spec: "With Foiling". ✅
- USD, no VAT note. ✅
- Pricing tiers: 250, 500, 750, 1,000 only (foiling has fewer featured_quantities). ✅

### Row 14 — Letterpress 1-ink core-colour GBP single

Proof: `6643a866-ef97-4eab-9d3b-83fa106eb9a2`

- Material: Letterpress. Construction section renders correctly. ✅
- Colorplan cross-section: Front: China white / Core: China white / Back: Adriatic. ✅
- INK COLOURS: Pantone 287. ✅
- GBP, VAT included. ✅

### Row 15 — Letterpress Gilded 2-ink EUR split-2

Proof: `c566350e-0af2-46f1-a5ee-7d944fceda62`

- Material: Gilded Letterpress (distinct material code, not an add-on). ✅
- Construction section: Front: China white / Core: China white / Back: Adriatic. ✅
- INK COLOURS: Pantone 287, Pantone 485. ✅
- "1 UNIQUE PROOF · 2 PEOPLE". NAMES: Alice + Bob. ✅
- Split-name tooling: "1 extra name × 39 € tooling". ✅
- EUR, no VAT note. ✅

### Row 16 — Acrylic GBP single

Proof: `f22f1ad9-bea5-477f-ba4b-53c96d43fdcb`

- Material: Acrylic. GBP, VAT included. No option switcher. ✅
- Pricing renders correctly. Single name "—". ✅
- Note: split-name surcharge is enabled in the DB (000146 backfill), confirmed by source; not exercised here as this is a single-name fixture.

### Row 17 — Carbon Fibre USD single

Proof: `7ce424d4-960f-44c8-88c3-da6121f701de`

- Material: Carbon Fibre (`carbon_fibre` code). USD, no VAT. ✅
- No option switcher — 000098 removed the `Cutting` dimension from `carbon_fibre`; it is now a clean single-variant material. ✅

### Row 18 — Carbon Fibre with CNC GBP single

Proof: `e6135043-0da0-4943-8cb8-95fbc7f0f893`

- Material: Carbon Fibre with CNC (distinct material, `carbon_fibre_cnc` code, from 000098 split). ✅
- GBP, VAT included. No option switcher. ✅
- Own price tiers (higher than plain Carbon Fibre): qty 50 = £349 vs Carbon Fibre USD $309. ✅

---

## Playbook discrepancy noted

**Row 2 playbook entry reads "400µm, Brushed"** — no 400µm variant exists in the DB for steel. The thinnest available steel variant is 500µm (`variant_type=thickness`, `code=500um`). The fixture was seeded with 500µm. The playbook row description should read "500µm, Brushed".

Action: update the playbook row 2 entry to correct the thickness.

---

## What this sweep did not cover

- Customer action flows (approve, request changes, variant selection) — covered by rows 23–32 of the matrix.
- Mirror/Brushed tab surcharge at every quantity tier (spot-checked qty 50 for Row 1 only; surcharge schedule verified by seed data).
- Split-name flows for Acrylic, Carbon Fibre, Carbon Fibre CNC (single-name fixtures only; split-name surcharge enablement confirmed in DB from 000146).
- The "Show all quantities" expand row on the pricing table (each row only shows featured quantities).
