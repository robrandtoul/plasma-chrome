# CLAUDE.md

Proof viewer web app for Plasma Design. This file gives Claude Code the context needed to work in this repo without re-deriving decisions that are already made.

Global business rules (VAT, Help Scout, Xero, pricing surcharges, British English) live in Rob's global `~/.claude/CLAUDE.md` and apply here. This file covers the repo-specific bits.

## Stack

- Supabase (Postgres + auth + storage) for the backend
- React 19 + Vite frontend, TypeScript, Tailwind v4, React Router v7
- Frontend deployed to Netlify
- Custom subdomain served via Hostinger DNS
- Migrations live under `supabase/migrations/`, numbered `NNNNNN_description.sql`
- Seed data in `supabase/seed.sql`
- Rob is a non-coder — step-by-step explanations, short commits, no surprises

## Database state

Migrations 000001–000127 have been applied. Migration 000005 originally installed a single flat `pricing_tables` table that didn't match reality; it was replaced by `000009_rebuild_pricing.sql`, which installs the current five-table pricing model. The `finishes` concept introduced in 000020 was later generalised to `material_options` in 000025.

Migration summary (post-000009):

- **000010/000011** — app tables (proofs, contacts, companies, proof_versions, proof_version_images), multi-variant proofs
- **000012–000014** — featured quantities on materials, multi-image versions
- **000015** — companies + contacts schema
- **000016** — global + per-material disclaimers (site_settings table, materials.disclaimer)
- **000017** — proof status: `in_progress` | `approved`, `approved_at`
- **000018** — dormant status + `last_activity_at` + `bump_proof_activity` trigger (only flips dormant→in_progress, other statuses pass through)
- **000019** — pg_cron daily job `mark_dormant_proofs()` (30-day inactivity threshold)
- **000020** — `finishes` + `finish_surcharges` tables (later renamed), proof_versions.finishes, proof_version_images.finish, seeds Steel/Gold with Natural/Brushed/Mirror
- **000021** — `proof_version_images.original_filename`
- **000022** — `abandoned` status + `abandoned_at`, view updates
- **000023** — `proof_versions.custom_quote` flag
- **000024** — `materials.requires_ink_names` flag (plastic_translucent/tinted/satin + paper_letterpress)
- **000025** — rename finishes→material_options, finish_surcharges→material_option_surcharges, columns renamed to match; adds `materials.option_label`; seeds five wood species (Black Walnut base, American Cherry, Finnish Birch, Canadian Maple, Bamboo — no surcharges)
- **000026** — carbon fibre "Cutting" option (Without cutting = base, Optional CNC cutting = 39-tier × 3-currency surcharge)
- **000126** — `maybe_finalize_proof_status()` trigger on `proof_name_approvals`. After a direct customer approval (state='approved', carried_from_version_id IS NULL), if the proof's current version has every required slot approved (names[] + '__shared__' iff the version has any associated_name=null images), the proof flips to `status='approved'` + `approved_at=now()`. Skips carry-forward writes; never overrides `abandoned` or already-`approved`. Designer's "Mark as approved" button is now belt-and-braces, not the only path.
- **000127** — `dashboard_latest_events` view extended via UNION ALL with non-bot rows from `proof_version_views`, deduped to first view per (proof_version_id, day). Synthesises `event_type='view'` rows with `actor_name = contact.full_name` (fallback 'Customer') so the sidebar reads as a unified customer-activity timeline. The `proof_events.event_type` CHECK constraint is unchanged — 'view' only ever appears in the view's output, never as a stored row. Dashboard cap bumped from 10 → 20 to absorb the extra volume.

`seed.sql` (applied via 000009's pricing rebuild) contains roughly 16,000 price-tier rows sourced from the per-currency Pricing CSVs in Rob's Dropbox (`mnt/Pricing`). The generic `add_ons` / `add_on_prices` tables are still present but largely superseded by `material_options` for anything that behaves as a switchable dimension on a proof.

## Pricing schema

Core tables:

- `materials` — one row per product family. Has `code` (unique), `display_name`, `category`, per-currency split-name tooling surcharges, `featured_quantities` (which qty tiers show by default), `disclaimer`, and two behaviour flags:
  - `requires_ink_names` (000024) — if true, the version form shows N labelled ink fields where N = selected variant's `ink_count`, all required.
  - `option_label` (000025) — singular form like "Finish", "Species", "Cutting". UI pluralises heuristically (`src/lib/labels.ts`).
- `material_variants` — thickness / ink_count / finish per material. `variant_type` is a discriminator: `thickness` | `ink_count` | `finish` | `default`. Has `ink_count` (used by requires_ink_names path).
- `price_tiers` — keyed by `(material_variant_id, currency, quantity)`, with `total_price` and `unit_price`.
- `material_options` — renamed from `finishes` in 000025. Second dimension beyond variant; one row per option per material. `code`, `display_name`, `is_base`, `sort_order`.
- `material_option_surcharges` — renamed from `finish_surcharges`. `(material_option_id, currency, quantity) → surcharge`. Optional: a base option with no surcharge rows (e.g. Natural, Without cutting, Black Walnut) means "use the price grid as-is".
- `add_ons` / `add_on_prices` — legacy, kept for catalogue entries without pricing data. Not used by the form.

`proof_versions` has `material_id`, `material_options text[]` (which options this version offers), `currency`, `pricing_snapshot` (JSON of base prices at creation time), `custom_quote`, `finishes` (old column dropped — see 000025 rename).

`proof_version_images` has `material_option text | null` (which option tab this image belongs to — null = shown across all options / pre-migration data) and `original_filename text | null`.

**Key rule:** `variant_type` is the single variant-dimension discriminator. `material_options` is a separate dimension that any material can use. No material uses more than one variant_type simultaneously, so always filter variants by the material's `variant_type`.

## Public views

Customer-facing queries all go through `public_*` views so RLS can stay strict:

- `public_proofs` — proofs + contact/company joined, exposes status + approved_at + abandoned_at
- `public_proof_versions` — includes `material_options`, `option_label`, `custom_quote`, `material_disclaimer`, `featured_quantities`
- `public_proof_version_images` — includes `material_option`, `original_filename`
- `public_site_settings` — singleton row with `global_disclaimer`
- `public_material_options` / `public_material_option_surcharges` — option metadata + surcharges

Whenever a migration adds or renames a column on an underlying table, the relevant view must be dropped and recreated (PostgreSQL's `create or replace view` doesn't allow column reorder — append-only or drop+create).

## Data rules baked into seed.sql

- GBP prices are VAT-inclusive. EUR and USD prices are VAT-free.
- No interpolation between listed quantity tiers. The UI must constrain the quantity picker to values present in `price_tiers` for the chosen variant.
- Standard Paper is modelled as three finish variants (`standard`, `uv_spot`, `foiling`), not a base price plus additive add-ons, because the source CSV columns replace the base price rather than adding to it.
- USD Copper is seeded from Gun Metal USD pricing (identical thicknesses and quantity tiers).
- CMYK is included at no extra charge. The obsolete "with CMYK" CSV sheets are ignored.
- Split-name tooling surcharges live on `materials` (not on variants), per currency, per extra name beyond the first.
- Metal finish surcharges (Steel + Gold, Brushed/Mirror): identical 39-tier schedule across all three currencies. Seeded in 000020.
- Wood species are all priced identically (no surcharge rows). Choice of base is arbitrary — Black Walnut picked.
- Carbon fibre CNC cutting surcharges seeded per-currency in 000026.

## Not yet seeded

- **Letterpress edge gilding** — add-on row exists, no prices.
- **Engraving, edge colour, die-cut shape** — no CSV pricing exists at all. Schema can accept them later.

## Features built

Customer-facing (`/p/:proofId`):

- Approval banner, abandoned screen, 404 screen (quiet, not jarring)
- Version tabs with "Current" / "Approved" badge
- Option switcher (Finish / Species / Cutting — label from material.option_label)
- Image grid (single, dual, responsive) with lightbox; images filtered by active option tab
- Spec summary (material, option, inks) + dynamic option label
- Change notes
- Global + per-material disclaimers
- Pricing card: grid with featured-quantity default and "Show all quantities" expand row. Surcharges baked into cells for non-base option tabs. Custom-quote replaces grid with a quiet message. Footer prepends "Prices include VAT." for GBP.
- "+from £X" suffix on non-base option tabs (suppressed for materials without surcharges like wood).

Designer-facing:

- `/login` — Supabase auth
- `/` — dashboard: company/contact-grouped list, date/name sort, show/hide dormant, status pills (in_progress/approved/dormant/abandoned), "+" shortcut buttons on company headers (always visible, hidden for "No company") and contact rows (hover/focus-visible) that pre-fill the new-proof form
- `/proofs/new` — new-proof form with company+contact pickers; pre-fills from `?companyId=…` or `?contactId=…`
- `/proofs/:id` — proof detail: status pill + Custom quote pill, approve/abandon/reopen flows with confirm dialogs, Copy customer URL, Preview, Versions table with Current + Custom quote indicators, version modal (read-only)
- `/proofs/:id/versions/new` and `…/edit` — Pricing Display → Specification → Proof Images → Change Notes → Pricing Table, in that order
- Required fields: pricing display choice, currency (in standard mode), material, variant (when applicable), ink names (when material.requires_ink_names), images per option tab. Validation uses a `submitAttempted` flag + `shouldHighlight(key)` helper — rose borders + "Required" labels appear only after first save click; they clear live as fields become valid. First invalid field scrolls into view; a rose-toned toast ("Please complete all required fields to save") auto-dismisses after 5s.

## Frontend patterns

- `src/lib/useImageFileDrop.ts` — hook for zone-level + page-wide drag-and-drop image upload. Ignores internal thumbnail reorder drags by checking `dataTransfer.types.includes('Files')`.
- `src/components/PageDropOverlay.tsx` — pointer-events:none overlay card.
- `src/components/PricingDisplayField.tsx` — Standard vs Custom quote radio cards (label-wrapped radios, sr-only inputs with focus-within ring).
- `src/components/CurrencyField.tsx` — GBP/EUR/USD segmented pill (same pattern). Disabled on edit (currency locked at creation).
- `src/lib/labels.ts` — `pluralLabel("Finish") → "Finishes"`, `pluralLabel("Species") → "Species"` heuristic.
- `src/components/PricingDisplay.tsx` — shared price grid, accepts optional `quantitySurcharges: Record<number, number>` that bakes into every cell; exposes "Show all / Show fewer quantities" row inside the table as a full-width accessible button.

## Still to build

- Netlify deploy configuration
- Hostinger DNS for the custom subdomain
- Letterpress edge gilding prices
- Decision on engraving / edge colour / die-cut pricing model

## Git workflow

Commit changes locally as you work. Rob typically pushes manually at the end of a work session, but during this project he's consistently asked for "commit and push" at the end of each task — follow whatever he says. Never skip hooks (`--no-verify`) and never `--amend` a pushed commit without asking.

Local dev: Rob runs `npm run dev` in a separate terminal. Changes hot-reload so no deploy is needed to verify frontend work. For DB changes, `npx supabase db push` applies pending migrations against the remote project.

## Working style

- Rob is a non-coder doing his first Claude Code project. Explain each step as you go, avoid jargon, don't assume knowledge of build tooling or SQL beyond the basics.
- Keep diffs focused and explainable — one feature per commit with a message that reads in plain English.
- Prefer tight, boring code over clever abstractions. When in doubt, match the existing pattern.
- Before claiming a feature is done, build (`npm run build`) to confirm types + bundle are clean. Skip `lint` unless there's a package.json script for it.
