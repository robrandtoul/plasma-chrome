# Proof Viewer, Claude Code Build Brief (v2)

This brief is for Claude Code. The visual design and prototype come separately from Claude Design as a handoff bundle. This document covers everything engineering: stack, data model, logic, deployment and security.

**What's already done** (before any code is written):

- Supabase project exists and is linked to this repo.
- GitHub repo exists, Netlify account exists, app folder exists.
- Migrations `000001` through `000009` are committed under `supabase/migrations/` and applied to the Supabase project. Migration `000009_rebuild_pricing.sql` installed a five-table pricing model (see "Pricing model" below).
- `supabase/seed.sql` is committed and applied. It contains roughly 16,000 price-tier rows and 393 add-on rows sourced from the Dropbox pricing CSVs.
- A repo-level `CLAUDE.md` at the project root captures the pricing schema and the seed-time data rules. Read it before making schema or seed changes.

**What this brief covers:** the app layer on top of the existing schema. Do not re-run the pricing migrations or re-seed. Phase 4 and Phase 5 of the first-build-session checklist are already complete.

## Context

We are building a web app for Plasma Design, a maker of bespoke business cards, that replaces an old JPEG-based proofing workflow. Designers upload a proof image and set specs, and customers view the proof and pricing at a hard-to-guess URL we share via email. Customer feedback happens in Help Scout and is not handled by this app.

## Tech stack

- **Frontend**: React, TypeScript, Vite. Use Tailwind for styling so the design tokens from the Claude Design handoff translate cleanly.
- **Database, auth and file storage**: Supabase (already provisioned).
- **Source control**: GitHub, private repo (already exists).
- **Hosting**: Netlify, connected to the GitHub repo for auto-deploy on push.
- **Domain**: custom subdomain via Hostinger DNS, pointed at Netlify after the app is live.

Please scaffold the React app, wire up the Supabase client, and walk me through each command and credential before I run it.

## Data model

All tables live in Supabase Postgres. Row Level Security is enabled on every table.

### Tables added by this brief

Only three app-facing tables are new. Everything pricing-related already exists.

#### profiles

Standard Supabase auth user, extended with a display name.

- `id` (uuid, primary key, references auth.users)
- `full_name` (text)
- `created_at` (timestamptz, default now())

Policies: each profile readable and writable only by the owner.

#### proofs

One record per customer job, which may have many versions over time.

- `id` (uuid, primary key, defaults to `gen_random_uuid()`, used in the public customer URL)
- `customer_name` (text, required)
- `company` (text, nullable)
- `helpscout_thread_url` (text, nullable, internal)
- `internal_notes` (text, nullable, internal)
- `created_by` (uuid, fk to profiles.id)
- `created_at` (timestamptz, default now())
- `updated_at` (timestamptz, auto-updated on row change)

Policies:

- Read: anyone can read the non-internal columns (`id`, `customer_name`, `company`, `created_at`); authenticated designers can read all columns.
- Write: authenticated designers only.

Implementation note: to expose only non-internal columns to the public customer page, create a view `public_proofs` that selects only the safe columns. The customer page reads from this view.

#### proof_versions

One record per iteration. Nothing is ever overwritten.

- `id` (uuid, primary key, default `gen_random_uuid()`)
- `proof_id` (uuid, fk to proofs.id, cascade delete)
- `version_number` (int, unique per proof_id, auto-incremented via trigger)
- `image_path` (text, Supabase Storage path to the JPEG)
- `material_variant_id` (uuid, fk to `material_variants.id`, nullable — see note below)
- `material_display` (text, required, e.g. "Steel" or "Standard Paper")
- `variant_display` (text, required, e.g. "0.5mm", "2 inks", "UV Spot" or "Default")
- `ink_names` (text[], display names of the customer's inks)
- `currency` (text, check in 'GBP','EUR','USD')
- `pricing_snapshot` (jsonb, e.g. `{"100": 219, "250": 262, "500": 345}`, immutable once written)
- `shipping_note` (text, default 'Prices exclude shipping')
- `change_notes` (text, nullable)
- `is_current` (bool, default false)
- `created_at` (timestamptz, default now())

**Why the `material_display` + `variant_display` text columns alongside the fk:** pricing data may change over time (new thicknesses added, old ones retired). The customer-facing version must remain readable forever even if the referenced variant is later removed. The fk is kept for internal traceability; the display text is the source of truth on the customer page.

Constraints and triggers:

- Trigger on insert: set `version_number` to `max(version_number) + 1` for that proof, starting at 1.
- Trigger on insert: set `is_current = true` on the new version, unset it on all siblings of the same proof in the same transaction.
- Trigger on update of `is_current` to true: unset it on all siblings in the same proof.
- `pricing_snapshot` must be treated as immutable. Add a trigger that raises an error on update of that column.
- Currency must match the currency of the price tiers used to build the snapshot.

Policies:

- Read non-internal columns: public (via a `public_proof_versions` view exposing `id`, `proof_id`, `version_number`, `image_path`, `material_display`, `variant_display`, `ink_names`, `currency`, `pricing_snapshot`, `shipping_note`, `is_current`, `created_at`).
- Read all columns: authenticated designers.
- Insert, update, delete: authenticated designers only.

### app_settings

A single-row table holding global configurable copy.

- `id` (int, always 1, enforced via check constraint)
- `disclaimer_html` (text, the disclaimer shown on the customer page)
- `updated_at` (timestamptz)

Policies: read public, write authenticated designers only.

### Supabase Storage

One bucket, `proof-images`, private. Images are accessed via signed URLs generated server-side (valid for 24 hours, regenerated each page load). Public read must not be enabled on the bucket directly.

## Pricing model (existing)

This is already installed by migration `000009_rebuild_pricing.sql`. Don't change the shape. Repeat from `CLAUDE.md` so it's in one place:

- `materials` — one row per product family (Steel, Gold, Copper, Wood, Letterpress, etc). Holds per-currency split-name tooling surcharges.
- `material_variants` — thickness, ink-count or finish options per material. `variant_type` is a discriminator with values `thickness | ink_count | finish | default`. A material uses exactly one variant dimension.
- `price_tiers` — keyed by `(material_variant_id, currency, quantity)`, with `total_price` and `unit_price`.
- `add_ons` — optional extras, each with `pricing_model` of `per_quantity_tier | flat | custom_quote`.
- `add_on_prices` — per-currency, per-quantity surcharge rows linked to add-ons.

Key rules:

- GBP prices are VAT-inclusive. EUR and USD prices are VAT-free.
- No interpolation between listed quantity tiers. The UI must constrain the quantity picker to values that actually exist in `price_tiers` for the chosen variant.
- CMYK is included at no extra charge. No add-on needed.
- Split-name tooling surcharges live on `materials`, not on variants, per currency per extra name beyond the first. v1 does not expose a split-name UI — designers override the snapshot manually if needed.

## Business logic

### Creating a new proof

- Auth required.
- Insert into `proofs` with `created_by = auth.uid()`.
- Returns the new proof with its id.

### Adding a new version

- Auth required.
- Upload JPEG to Supabase Storage at `proof-images/{proof_id}/{uuid}.jpg`.
- The designer picks a material family, then a variant within that material, then a currency. The UI then offers the quantity tiers that exist in `price_tiers` for `(material_variant_id, currency)`.
- Build the `pricing_snapshot` by querying `price_tiers` where `material_variant_id = :id AND currency = :currency`, then shaping the result as `{ "<quantity>": total_price, ... }`. Allow the designer to override individual values in the UI before insert.
- `material_display` and `variant_display` are set from the chosen material and variant. For materials with `variant_type = default`, `variant_display` should be `'Default'` (or hidden from the customer page depending on the design).
- Insert into `proof_versions`. Triggers handle `version_number` and `is_current`.

### Changing which version is current

- Auth required.
- Update `is_current = true` on the chosen version. Trigger ensures siblings are unset.

### Customer viewing a proof

- No auth required.
- URL pattern: `/p/{proof_id}`.
- Look up the proof via the `public_proofs` view.
- List all versions for that proof via `public_proof_versions`, resolving `image_path` to a signed URL (valid for 24 hours, regenerated each page load).
- Default the visible version to the one with `is_current = true`.
- Return 404 if `proof_id` is invalid.
- Customers only ever see `material_display`, `variant_display`, `ink_names`, `pricing_snapshot`, `shipping_note`. They never see the fk.

## Routes

### Public

- `/p/:id` — customer proof page

### Authenticated (designers)

- `/login`
- `/` — designer dashboard, lists all proofs (v1: all designers see all)
- `/proofs/new` — new proof form
- `/proofs/:id` — proof detail page, with version list and "Add version" action
- `/proofs/:id/versions/new` — add-version form (modal or full page)
- `/logout`

## Security

- Supabase RLS enabled everywhere. No public bypass.
- UUIDs for proof IDs (standard v4), used directly in URLs.
- Image storage bucket private. URLs signed server-side on demand.
- Validate uploads: only `image/jpeg` and `image/png`, max size 10MB, sanity-check dimensions.
- Standard CORS, HTTPS only, no mixed content.
- No PII beyond what designers enter themselves. No customer-entered data on the public side.

## v1 non-goals

- No customer login, no feedback form, no in-app change request.
- No Typeform integration.
- No Help Scout API integration.
- No PDF export.
- No interactive quantity selector on the customer page (tiers are shown as a table).
- No admin UI for pricing data. Edit via Supabase dashboard or a future admin screen.
- No add-ons UI. The schema supports them; v1 does not expose them.
- No split-name surcharge UI. Designers manually override snapshot values where needed.
- No mirror/brushed upgrade, edge gilding, or CNC cutting selectors. These add-ons exist in the schema without seeded prices.

## Future-proofing

Architecture should remain compatible with all of these:

- A "Request changes" button on the public page that triggers an edge function posting a note to Help Scout via their API. The `helpscout_thread_url` field on `proofs` is the link.
- A Typeform webhook that creates a proof skeleton with customer details pre-filled.
- A PDF export of the customer page.
- A quantity selector and live totals including shipping, driven by `price_tiers`.
- An admin UI for editing pricing data in the app.
- Multi-currency display on a single proof. Store multiple snapshots per version, keyed by currency.
- Add-on application (metal finish upgrade, letterpress gilding, carbon CNC, etc.).
- Split-name tooling surcharge applied automatically when more than one name is in play.

## Development setup

Please walk me through the following in order, explaining each step and command before I run it.

1. Install Node via nvm, install pnpm, install the Supabase CLI, install the Netlify CLI.
2. Clone the existing GitHub repo locally. Do not initialise a new one.
3. Pull Supabase credentials into a local `.env.local`. Do not run pricing migrations, they are already applied. Confirm the tables exist by connecting via the Supabase CLI or dashboard.
4. Scaffold the React app inside the repo with Vite, TypeScript, Tailwind and the Supabase client. Make sure the scaffold does not overwrite `supabase/` or `CLAUDE.md`.
5. Add the three app tables (`profiles`, `proofs`, `proof_versions`, plus the `app_settings` row and the two public views) as a **new** migration numbered `000010_app_tables.sql`. Apply it to Supabase.
6. Add the `proof-images` private Storage bucket via a migration or the CLI, whichever is cleanest.
7. Build the routes and pages incrementally, starting with the customer proof page, then the designer dashboard, then the forms.
8. Connect the GitHub repo to Netlify, set environment variables on Netlify, deploy the first version.
9. Walk me through setting up a custom subdomain via Hostinger DNS pointed at the Netlify deployment.

Throughout, if you need me to paste a credential, copy a file, or approve something in a web UI, give clear instructions and tell me what to look for once I've done it. Assume I understand what a terminal is and can copy-paste commands, but not that I always understand what they do.

## Design handoff

A separate Claude Design bundle contains the visual design system, component specs and per-screen mockups. Please consume that bundle as the source of truth for the look of the app, and align Tailwind tokens (colour scale, typography, spacing) with the design system defined in the bundle.
