# Per-option-tab image filtering — customer page (Row 42) — 2026-05-10

Browser verification of the image filtering behaviour when `proof_version_images.material_option` is set. Fixture seeded directly via Supabase REST (service role) in the same session.

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 42 | pass (browser) | Natural tab shows only null-option image; Mirror tab shows mirror-specific image + null-option image; pricing updates per tab; option switcher renders correctly |

No findings.

---

## Context

`proof_version_images.material_option` controls which option tab an image appears on:

- `null` — shown on all tabs (the "shared" case; pre-migration data also falls here)
- `"mirror"` — shown only on the Mirror tab
- `"brushed"` — shown only on the Brushed tab
- etc.

The filtering is applied in `CustomerProofPage.tsx`:

```typescript
const displayImages = versionOptions.length > 0 && effectiveOptionCode
  ? allVersionImages.filter(img => img.material_option === effectiveOptionCode || img.material_option == null)
  : allVersionImages
```

When no options are configured (`versionOptions.length === 0`), all images show regardless. When options are present, images are filtered to the active option OR null.

The option switcher renders when `versionOptions.length >= 2`. The first option in the `proof_versions.material_options` array is the default active tab.

---

## Fixture seeded (2026-05-10)

- **Proof:** `8a123a2e-d314-4dc9-adba-306eb5850297`
  - Contact: Johnny Appleseed (individual, no company)
  - Notes: `[QA-fn] Row 42 — Steel per-option-tab image filtering`
  - `helpscout_override_reason` set to satisfy DB check constraint (required: must have HS link or override reason)
- **Version:** `476a468a-48dc-47ab-8d50-fb584932e885`
  - `material_id`: Steel (`67928f71`)
  - `material_display`: `Stainless Steel`
  - `currency`: `GBP`
  - `material_options`: `["natural", "mirror"]` — two tabs; Natural is default (first in array)
  - `displayed_variant_ids`: 800 micron (`82fdd1f2`)
  - `is_variant_round`: false, `is_per_direction_pricing`: false
- **Image A** (`40f262eb`) — `material_option = "mirror"` (Mirror-only)
  - `original_filename`: `test-mirror-only.jpg`, `sort_order`: 0
- **Image B** (`9405726c`) — `material_option = null` (all tabs / shared)
  - `original_filename`: `test-all-tabs.jpg`, `sort_order`: 1

**Customer URL:** `http://localhost:5173/p/8a123a2e-d314-4dc9-adba-306eb5850297`

---

## Browser verification

### Natural tab (default)

Accessibility tree — Proofs region:

```
heading "Proofs"
"1 unique proof · Shared"
"Finish"
button "Natural"           ← active tab
button "Mirror · From +£30"
heading "Front"
button "SHARED · TEST-ALL-TABS, Proof version 1, view larger"
  image "Proof version 1"
"SHARED · TEST-ALL-TABS"
"test-all-tabs.jpg"
link "Download ↓"
```

✅ Only the null-option image (`test-all-tabs.jpg`) is shown — mirror-specific image correctly absent  
✅ Image count: "1 unique proof · Shared"  
✅ Pricing region: "Prices shown for Natural finish"  
✅ Option switcher renders with Natural (active) and Mirror ("From +£30") buttons  

### Mirror tab (after clicking Mirror button)

Accessibility tree — Proofs region:

```
heading "Proofs"
"2 unique proofs · Shared"
"Finish"
button "Natural"
button "Mirror · From +£30"   ← active tab
heading "Front"
button "SHARED · TEST-MIRROR-ONLY, Proof version 1, view larger"
  image "Proof version 1"
"SHARED · TEST-MIRROR-ONLY"
"test-mirror-only.jpg"
link "Download ↓"
button "SHARED · TEST-ALL-TABS, Proof version 1, view larger"
  image "Proof version 1"
"SHARED · TEST-ALL-TABS"
"test-all-tabs.jpg"
link "Download ↓"
```

✅ Both images shown on Mirror tab: `test-mirror-only.jpg` (mirror-specific) + `test-all-tabs.jpg` (null/shared)  
✅ Image count: "2 unique proofs · Shared"  
✅ Pricing region: "Prices shown for Mirror finish" with surcharges baked in  
✅ Sample surcharge check: qty 50 → Natural £299 vs Mirror £329 = £30 surcharge ✅  
✅ "+From £30" suffix on Mirror tab button ✅  

---

## Seeding notes

One issue surfaced during fixture creation:

**`proofs` check constraint `proofs_helpscout_link_or_override_chk`.** Even QA fixtures must satisfy: either `helpscout_conversation_id IS NOT NULL` or `helpscout_override_reason IS NOT NULL`. Fixed by adding `helpscout_override_reason = "QA fixture — no real HS conversation"`. This is correct behaviour — the constraint enforces that every proof has a HS provenance trail even if it's just an override note.

---

## What this sweep did not cover

- Brushed tab (only Natural and Mirror were included in this fixture's `material_options`). The same filtering logic applies; Natural/Mirror coverage is sufficient to confirm the pattern.
- Image grid layout with mixed option images across all three option tabs simultaneously — a more complex fixture would be needed.
- The designer edit flow for changing image option assignments (the literal "edit version, change images" path in the test matrix) — this covers the customer-facing result of that edit, not the designer UI. The designer UI verification is a separate row 42 sub-task if desired.
