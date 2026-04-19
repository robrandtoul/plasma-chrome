# CLAUDE.md

Proof viewer web app for Plasma Design. This file gives Claude Code the context needed to work in this repo without re-deriving decisions that are already made.

Global business rules (VAT, Help Scout, Xero, pricing surcharges, British English) live in Rob's global `~/.claude/CLAUDE.md` and apply here. This file covers the repo-specific bits.

## Stack

- Supabase (Postgres + auth + storage) for the backend
- Frontend deployed to Netlify
- Custom subdomain served via Hostinger DNS
- Migrations live under `supabase/migrations/`, numbered `NNNNNN_description.sql`
- Seed data in `supabase/seed.sql`

## Database state

Migrations 000001 through 000009 have been applied. Migration 000005 originally installed a single flat `pricing_tables` table that didn't match reality; it was replaced by `000009_rebuild_pricing.sql`, which drops the old table and installs the current five-table pricing model.

`seed.sql` contains roughly 16,000 price-tier rows and around 393 add-on rows, sourced from the per-currency Pricing CSVs in Rob's Dropbox (`mnt/Pricing`).

## Pricing schema

Five tables make up the pricing model:

- `materials`, one row per product family (Steel, Gold, Copper, Wood, Letterpress, and so on), holding the split-name tooling surcharges per currency
- `material_variants`, the thickness, ink-count or finish options per material; `variant_type` is a discriminator: `thickness` | `ink_count` | `finish` | `default`
- `price_tiers`, keyed by `(material_variant_id, currency, quantity)`, with `total_price` and `unit_price`
- `add_ons`, the catalogue of optional extras, each with a `pricing_model` of `per_quantity_tier` | `flat` | `custom_quote`
- `add_on_prices`, per-currency, per-quantity surcharge rows linked to add-ons

**Key rule:** `variant_type` is the single discriminator. No material uses more than one dimension simultaneously, so always filter variants by the material's `variant_type`. Do not assume every material has the same dimension.

## Data rules baked into seed.sql

- GBP prices are VAT-inclusive. EUR and USD prices are VAT-free.
- No interpolation between listed quantity tiers. The UI must constrain the quantity picker to values present in `price_tiers` for the chosen variant.
- Standard Paper is modelled as three finish variants (`standard`, `uv_spot`, `foiling`), not a base price plus additive add-ons, because the source CSV columns replace the base price rather than adding to it.
- USD Copper is seeded from Gun Metal USD pricing (identical thicknesses and quantity tiers). No dedicated Copper USD CSV exists.
- CMYK is included at no extra charge. The obsolete "with CMYK" CSV sheets should be ignored.
- Split-name tooling surcharges live on `materials` (not on variants), per currency, per extra name beyond the first. Values follow the rules in the global `CLAUDE.md`.

## Not yet seeded

Add-on rows exist for these extras but no prices are populated yet:

- `metal_finish_upgrade`, the Mirror / Brushed finish upgrade on Steel and Gold
- `letterpress_gilding`, edge gilding on letterpress cards
- `carbon_cnc`, CNC cutting for carbon fibre

Engraving, edge colour and die-cut shape have no CSV pricing at all and are not seeded. The schema allows them to be added later without further migration changes.

## Still to build

- Customer proof page (the click-to-approve side)
- Designer dashboard (upload proofs, manage workflow)
- Netlify deploy configuration
- Hostinger DNS for the custom subdomain

Design and code briefs for the customer page and designer dashboard are pending re-share from Rob.

## Git workflow

Commit changes locally as you work, but DO NOT push to GitHub automatically. Rob will push manually at the end of a work session to trigger a single Netlify build. If Rob explicitly says "push" or "deploy", then push — otherwise stay local.

Local dev workflow: Rob runs `npm run dev` in a separate terminal for testing. Changes are hot-reloaded in the browser, so no deploy is needed to verify work.