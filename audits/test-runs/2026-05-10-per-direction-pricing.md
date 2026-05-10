# Per-direction pricing — customer page (Rows 20–21) — 2026-05-10

Browser verification of the two per-direction-pricing test matrix rows. Fixtures seeded directly via Supabase REST (service role) in the same session.

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 20 | pass (browser) | Same-family variant round (Steel 800µm + Steel 500µm): pricing docket, Specification, About-material all absent; two direction cards render correctly |
| 21 | pass (browser) | Cross-family variant round (Steel Front + Gun Metal Back): same three sections absent; two direction cards render correctly |

No findings. Two P3 findings from rows 33–38 (same session) remain open — see `2026-05-10-designer-flow.md`.

---

## Context

Rows 20–21 test the `is_per_direction_pricing` flag on `proof_versions` (migration 000144, renamed from `is_mixed_materials` in 000142). When the flag is true, the customer page (`CustomerProofPage.tsx`) suppresses:

- The pricing docket / pricing card
- The Specification section (material, variant, inks)
- The About-material section
- The material description block

What remains is only the "Choose a direction" section with one card per `proof_round_variants` row, a header, and a footer.

The DB trigger (000142) enforces that per-direction-pricing versions have `material_id IS NULL`, `currency IS NULL`, `material_options = '{}'`. `material_display` is still NOT NULL (placeholder required). Images on variant-round versions must have `round_variant_id` set (trigger on `proof_version_images`).

---

## Fixtures seeded (2026-05-10)

Both fixtures are seeded under Johnny Appleseed / Plasma Design Ltd for test isolation. The same contact/company are used by other test fixtures and are not modified here.

### Row 20 — same-family (Steel 800µm vs Steel 500µm)

- **Proof:** `a59b8d2b-1872-436a-b540-9da05e4ea08c`
- **Version:** `edefb743-...` (`material_display = "Per-direction pricing"`, `is_per_direction_pricing = true`, `material_id = null`, `currency = null`)
- **Variants:**
  - Front 800µm: `3ebb9829-...` (`code = "front_800um"`, `display_name = "Front – 800µm"`, `sort_order = 1`)
  - Back 500µm: `0ce17b7c-...` (`code = "back_500um"`, `display_name = "Back – 500µm"`, `sort_order = 2`)
- **Image:** one borrowed image from the test-fixture library, linked to the Front 800µm variant (`round_variant_id = 3ebb9829-...`)

**Customer URL:** `http://localhost:5173/p/a59b8d2b-1872-436a-b540-9da05e4ea08c`

### Row 21 — cross-family (Steel Front vs Gun Metal Back)

- **Proof:** `f5494adb-f80d-4ff6-8f80-b92c31bec468`
- **Version:** `7c0c70e8-...` (`material_display = "Per-direction pricing"`, `is_per_direction_pricing = true`, `material_id = null`, `currency = null`)
- **Variants:**
  - Steel Front: linked to steel_front variant (`display_name = "Steel Front"`, `sort_order = 1`)
  - Gun Metal Back: linked to gunmetal_back variant (`display_name = "Gun Metal Back"`, `sort_order = 2`)
- **Image:** one borrowed image from the test-fixture library, linked to the Steel Front variant

**Customer URL:** `http://localhost:5173/p/f5494adb-f80d-4ff6-8f80-b92c31bec468`

---

## Row 20 — browser verification

**Accessibility tree (depth 4, viewport 1055×970):**

```
image "Plasma"
"Proof Viewer"
"Proof for"
heading "Johnny Appleseed"
region
  heading "Choose a direction"
  "2 directions · pick one"
  "Each direction is priced individually. See your email for details."
  article
    heading "Front – 800µm"
    button "Front – 800µm — proof version 1, view larger"
    link "Download ↓"
    button "Choose this direction"
  article
    heading "Back – 500µm"
    "No images uploaded for this direction yet."
    button "Choose this direction"
contentinfo
  image "Plasma"
  "© PlasmaDesign"
```

✅ No pricing docket  
✅ No Specification section  
✅ No About-material section  
✅ No material description block  
✅ Two direction cards rendered: "Front – 800µm" (with image + Download) and "Back – 500µm" (no-image state)  
✅ "Each direction is priced individually. See your email for details." helper text present  

---

## Row 21 — browser verification

**Accessibility tree (depth 4, viewport 1055×970):**

```
image "Plasma"
"Proof Viewer"
"Proof for"
heading "Johnny Appleseed"
region
  heading "Choose a direction"
  "2 directions · pick one"
  "Each direction is priced individually. See your email for details."
  article
    heading "Steel Front"
    button "Steel Front — proof version 1, view larger"
    link "Download ↓"
    button "Choose this direction"
  article
    heading "Gun Metal Back"
    "No images uploaded for this direction yet."
    button "Choose this direction"
contentinfo
  image "Plasma"
  "© PlasmaDesign"
```

✅ No pricing docket  
✅ No Specification section  
✅ No About-material section  
✅ No material description block  
✅ Two direction cards rendered: "Steel Front" (with image + Download) and "Gun Metal Back" (no-image state)  
✅ Cross-family variant round: `is_per_direction_pricing` flag behaves identically regardless of whether directions share a material family  

---

## Seeding notes

Two issues surfaced during fixture creation:

1. **`material_display` NOT NULL on per-direction-pricing versions.** Even though the version has no material, the column is still NOT NULL. Fixed by supplying `"material_display": "Per-direction pricing"` as a placeholder. Worth noting if this column is used in any customer-facing rendering path in future.

2. **`proof_version_images.round_variant_id` required on variant-round versions.** The trigger enforces `NOT NULL` for images on versions that have `proof_round_variants` rows. Setting `round_variant_id = null` returns a 400. Fixed by linking the image to the first (front/steel) variant's UUID. This is correct behaviour.

Both issues are schema-enforced constraints working as intended, not bugs.

---

## What this sweep did not cover

- **Row 20/21 approve flow:** The "Choose this direction" button was visible and not clicked during this audit. The approval path for per-direction-pricing versions is outside scope here.
- **Row 42 (per-option-tab image filtering):** Still outstanding. Requires images with `material_option: "mirror"` set so they appear only on the Mirror tab. Separate fixture needed.
