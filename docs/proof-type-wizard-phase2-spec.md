# Spec: Proof-type wizard — Phase 2 (persistence, per-layout artwork, customer rendering)

Status: draft for review
Author: Rob + Claude (Cowork)
Audience: Claude Code (implementer) and Rob (non-coder owner)
Repo: `/Users/robrandtoul/proof-viewer/`
Companion to: `docs/proof-type-wizard-spec.md` (Phase 1, already on `feat/proof-type-wizard`)

---

## 1. Where Phase 1 left off

Phase 1 shipped the wizard UI and routing with no schema. The three shapes resolve and drive
the existing form state (Recipients, Selection, and Set via `cardType=membership` + empty names).
Set (collection) is **preview-only**: the layout-title editor is real and clickable, but Save is
blocked and the titles do not persist, because there is nowhere to store them and no per-layout
identity for images to attach to.

Phase 2 makes Set (collection) a real, saveable proof end to end.

## 2. Goal and non-goals

**Goal.** Persist the resolved shape and the per-layout titles, give each layout its own image
drop zone, price per-layout tooling, and render plus approve a Set (collection) on the customer
page. Remove the Phase 1 Save block.

**Non-goals.**

- No change to Recipients or Selection behaviour, or to variant rounds.
- No new pricing model. Per-layout tooling reuses the existing split-name surcharge mechanic.
- Not adding per-layout personalisation or per-layout materials. A Set is one material; numbering
  (if membership) applies across the set, not per layout.

## 3. What ships

1. A first-class `shape` column on `proof_versions`.
2. Storage for per-layout titles with a stable identity, plus per-layout image association.
3. Per-layout image drop zones in the version form, reusing the existing per-slot image plumbing.
4. Removal of the preview-only Save block, with full validation for collections.
5. Per-layout tooling pricing, reusing the split-name surcharge mechanic.
6. Customer-page rendering: each layout as its own section, approve-each across all layouts, and
   the tooling line in the pricing card.

## 4. Data model (additive, backward-compatible)

All changes are additive so they are inert on production until a Set (collection) is actually
created (no existing row has `shape = 'set_collection'`). See section 9 on sequencing.

- **`proof_versions.shape`** — nullable text/enum: `recipients | set_single | set_collection |
  selection`. Makes the shape first-class so the customer page and dashboard can branch without
  re-deriving from flags, and so Set-single and Recipients (which both map to `cardType` today)
  are finally distinguishable. Backfill existing rows in a separate idempotent data migration by
  deriving from current flags (`isVariantRound` → selection; `cardType=membership` + empty names →
  set_single; `cardType=business` → recipients). The wizard writes it going forward.

- **`proof_layouts`** — new table, mirroring `proof_round_variants` deliberately so it reuses the
  same per-slot patterns: `id uuid pk`, `proof_version_id uuid fk`, `title text not null`,
  `sort_order int not null`, `created_at`. One row per titled layout in a Set (collection).
  RLS: authenticated CRUD; anon revoked (customers read through the existing RPC/views, never the
  table). **Recommended over reusing `proof_round_variants`** — keeping "pick one" (round variants)
  and "receive all" (layouts) as separate tables avoids the same overloading we refused for the
  `names` array, and keeps the finalisation rules legible.

- **`proof_version_images.layout_id`** — nullable uuid fk → `proof_layouts`. Set on a
  collection's images; null for shared/named/round-variant images. This is the per-layout
  equivalent of `associated_name` (Recipients) and `round_variant_id` (Selection).

- **Public surface.** `public_get_customer_proof` and `public_proof_version_images` must expose
  `layout_id` and the layouts list so the customer page can group images by layout. Any view
  dropped and recreated **must re-state its grants** (`REVOKE SELECT ... FROM anon, public`,
  `GRANT SELECT ... TO authenticated`, and `security_invoker = on`) — the recurring footgun
  (000168/000174). New table needs no anon grant.

## 5. Approval semantics (highest-risk piece)

A Set (collection) is **approve-each**, not pick-one. Each layout is a required approval slot, and
the proof finalises to `approved` only when every layout is approved — exactly the Recipients
rule, but with layouts as the slot identity instead of names.

- Reuse the per-recipient finalisation logic (`_finalize_proof_if_complete` /
  `maybe_finalize_proof_status`), extending the "required slots" set to include the version's
  layouts when `shape = 'set_collection'`.
- The variant-round bail guard must **not** catch Set (collection) — it is not a round.
- Carry-forward across versions must copy per-layout approvals when the layout set is unchanged,
  the same way names are carried (`NewVersionPage` carry-forward block).
- Treat this as the riskiest change: modify the function so the Recipients and Selection paths are
  byte-for-byte unchanged, and rely on the fact that no live proof is `set_collection` yet.

## 6. Pricing

Per-layout tooling is mathematically identical to the split-name surcharge:
`(layoutCount - 1) × per-item tooling` for the material and currency.

- Reuse the existing tooling-surcharge helper and the customer-page tooling card, feeding it the
  layout count instead of the name count, and relabel the customer-facing noun from "name" to
  "layout" on Set jobs.
- Capture the surcharge in `pricing_snapshot` at save, as today.
- If the Set is membership + personalised, the personalisation line stacks on top of the per-layout
  tooling line, both rendered in the customer pricing card (the quote calc already sums them as
  separate lines).

## 7. Version form

- Wire the Phase 1 layout-title editor to create/update/delete `proof_layouts` rows on save.
- **Per-layout drop zone:** each titled layout shows its own image zone; uploads set `layout_id`.
  Reuse `useImageFileDrop` and the round-variant image-slot pattern rather than inventing new
  upload plumbing.
- **Validation:** a collection requires at least two layouts, each with a non-empty title and at
  least one image. Remove the preview-only Save block (`canSave` no longer excludes
  `set-collection`); the `handleSubmit` guard is replaced by real validation.
- **EditVersionPage:** shape stays locked at creation (as in Phase 1), but the collection itself
  is **fully editable** (decision 3): layout titles and images can be edited, and layouts added or
  removed, on a later version. This means carry-forward of per-layout approvals must key on a
  stable layout identity, only an unchanged layout (same `proof_layouts.id`, same image set) carries
  its approval forward; a renamed, re-imaged, added, or removed layout resets to unapproved. Do not
  carry approvals by `sort_order` or title, which both change.

## 8. Customer page

- Render the set as one section per layout, each with its title and images, in `sort_order`.
- Approve-each: the customer approves every layout; no "pick one" UI, no lock-on-selection.
- Pricing card: base volume price plus a "per-layout tooling" line (e.g. "N extra layouts × £X"),
  plus the personalisation line if applicable.
- Reuse the per-recipient section rendering, swapping the name slot identity for the layout title.

## 9. Migration and delivery discipline

- `ls supabase/migrations/0001*` and pick max+1; do not trust the doc's migration summary.
- Additive only. New table, new nullable columns, view drop+recreate with grants + `security_invoker`
  re-stated. After `CREATE TABLE proof_layouts`, enable RLS and confirm the authenticated CRUD /
  anon-revoked posture (the `ALTER DEFAULT PRIVILEGES` from 000176 grants authenticated CRUD by
  default; no anon grant).
- The `shape` backfill is a separate, idempotent migration deriving from existing flags.
- The finalisation change is behaviour-changing only for `set_collection`, which no live proof is,
  so it is inert on production until the feature is used. Keep Recipients/Selection branches
  unchanged.
- One shared Supabase behind prod and preview: migrations hit production the moment they are pushed.
  They are safe to push because they are additive and gated on a shape no live proof has, but push
  them only once the form and customer wiring that uses them is ready, so the feature appears whole.
- `npm run build` clean before pushing. Stage explicit paths. Branch off `feat/proof-type-wizard`
  once it has merged, or a fresh `feat/proof-type-wizard-phase2` branch.

## 10. Suggested build order

1. Schema: `shape` column + backfill, `proof_layouts`, `proof_version_images.layout_id`, and the
   view/RPC updates (grants re-stated).
2. Finalisation logic for layout slots (highest risk — verify Recipients/Selection unchanged).
3. Form: persist layouts, per-layout drop zones, real validation, remove the Save block.
4. Customer page: render the set, approve-each, the tooling pricing line.
5. Edit-page handling per the open-question decision.
6. Build, push, and test the four-informational-cards case end to end on the preview: create it,
   approve every layout as the customer, confirm it flips to approved, and confirm the pricing
   (base volume + (layouts − 1) × tooling) is correct.

## 11. Decisions (resolved)

1. **Shape backfill** — backfill existing rows' `shape` from their current flags (separate
   idempotent migration).
2. **Storage** — new `proof_layouts` table, not a reuse of `proof_round_variants`.
3. **Editing a collection** — fully editable on a later version: titles and images editable,
   layouts can be added and removed. Carry-forward keys on stable `proof_layouts.id` (see section 7).
4. **Minimum layouts** — a collection is always two or more layouts; a single layout is always
   Set (single).
5. **Set (single) storage** — gets the `shape` value but no `proof_layouts` rows (one shared slot,
   as today). No one-row layout table for singles.
