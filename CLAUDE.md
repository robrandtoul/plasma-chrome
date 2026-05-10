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

Migrations 000001–000164 have been applied. Migration 000005 originally installed a single flat `pricing_tables` table that didn't match reality; it was replaced by `000009_rebuild_pricing.sql`, which installs the current five-table pricing model. The `finishes` concept introduced in 000020 was later generalised to `material_options` in 000025. A second batch (000128–000150) shipped the per-recipient approval flow, letterpress core/front/back colours, variant rounds with the per-direction-pricing sub-mode, and several pricing reconciles. 000151 closed the previously-pending follow-up by adding the missing REVOKE on the 000148 view. A third batch (000152–000155) shipped the redesigned designer dashboard: tile-counts + needs-attention scaffolding, a designer-profile cleanup, the configurable Needs-attention rules engine, and the `proof_pins` table for Pinned and Team sections. A fourth batch (000156–000158) reconciled live `profiles.helpscout_user_id` values into source, seeded the three customer-confirmation reply templates the proof-action edge function resolves by code, and added the `reopen_proof` RPC that flips status and clears stale per-recipient approvals atomically. A fifth batch (000163–000164) shipped the snooze feature: the `proof_attention_snoozes` table and the updated rules engine + dashboard view that exclude snoozed (proof_id, rule_code) pairs from needs-attention results.

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
- **000026** — carbon fibre "Cutting" option (Without cutting = base, Optional CNC cutting = 39-tier × 3-currency surcharge). Later superseded by 000098, which promoted CNC cutting to its own material `carbon_fibre_cnc` rather than a per-material option dimension; the `Cutting` option no longer exists on live.
- **000098** — split CNC cutting and gilded letterpress into distinct materials. Inserts `carbon_fibre_cnc` and `paper_letterpress_gilded` as standalone materials with their own variants, price tiers, and split-name surcharges; tears down 000026's per-material `Cutting` dimension on `carbon_fibre` (nulls `option_label`, deletes the two `material_options` rows + 117 cascade-dropped surcharges). Rationale: optional finishing that materially changes the product is modelled as a separate material rather than an option, so the artwork the customer approves matches the product they order.
- **000126** — `maybe_finalize_proof_status()` trigger on `proof_name_approvals`. After a direct customer approval (state='approved', carried_from_version_id IS NULL), if the proof's current version has every required slot approved (names[] + '__shared__' iff the version has any associated_name=null images), the proof flips to `status='approved'` + `approved_at=now()`. Skips carry-forward writes; never overrides `abandoned` or already-`approved`. Designer's "Mark as approved" button is now belt-and-braces, not the only path.
- **000127** — `dashboard_latest_events` view extended via UNION ALL with non-bot rows from `proof_version_views`, deduped to first view per (proof_version_id, day). Synthesises `event_type='view'` rows with `actor_name = contact.full_name` (fallback 'Customer') so the sidebar reads as a unified customer-activity timeline. The `proof_events.event_type` CHECK constraint is unchanged — 'view' only ever appears in the view's output, never as a stored row. Dashboard cap bumped from 10 → 20 to absorb the extra volume.
- **000128–000137** — per-recipient approval flow polish, audit-actor backfills, key-features model upgrade (string[] → KeyFeature[]), letterpress core-colours catalogue + per-version picker (000133), Colorplan card-type metadata.
- **000133/000135** — letterpress edge construction. 000133 adds the `letterpress_core_colours` admin-managed palette + per-version `core_colour_id`; 000135 adds the `front_colour_id` / `back_colour_id` siblings so the customer page can render a layered Colorplan cross-section. All three pull via left joins so non-letterpress / gilded versions return null across the board.
- **000138/000139/000140/000141/000143** — variant rounds. 000138 introduces `proof_round_variants` (write-once `code`, `display_name`, `sort_order`) and `proof_version_images.round_variant_id`; 000139 surfaces the new shape on the public_* views; 000140 widens RLS for authenticated CRUD on `proof_round_variants`; 000141 hardens `maybe_finalize_proof_status` against variant-round state; 000143 backfills `side='front'` on legacy variant images.
- **000142** — `proof_versions.is_mixed_materials` boolean for variant rounds where each direction is a distinct material; loosens `material_id` / `currency` NOT NULL with a trigger asserting the equivalent constraints for non-variant-round rows.
- **000144** — rename `is_mixed_materials` → `is_per_direction_pricing` (column + view + trigger). Per-direction pricing also fires when directions differ in thickness / tier within one material family, so the by-materials framing was misleading. Customer page hides pricing card, Specification, and About-material when this is true.
- **000145** — backfill the qty 25 row of the metal Mirror/Brushed surcharge schedule across all three currencies. The 39-tier schedule shipped in 000020 was missing the qty 25 row that the rest of the metal grids have always had.
- **000146** — drift reconcile. Reverts a single `metal_gun_metal | 800um | GBP | 750` tier back to the seed canonical (1799.00) and captures four split-name surcharge enablements (acrylic, carbon_fibre, carbon_fibre_cnc, paper_standard) that were applied directly to live and never made it into source. Wood remains null. Update Rob's global `~/.claude/CLAUDE.md` pricing rules to match if not already done.
- **000147** — drop the orphan `add_on_prices` rows for `metal_finish_upgrade`. The admin Mirror/Brushed editor used to read/write `add_on_prices`; it now points at `material_option_surcharges` (b4d7ecd / 3935b72). The catalogue `add_ons.metal_finish_upgrade` row stays as the route key.
- **000148** — `material_price_tier_counts` aggregate view. Replaces the admin pricing index's "fetch every price_tiers row and roll up client-side" path that silently truncated to supabase-js's 1000-row cap. NOTE: shipped without the explicit `revoke from anon, public` defence pattern; 000151 adds it.
- **000149/000150** — strip the auto-appended sign-off from seeded reply templates. 000149 used a strict equality check that matched zero live rows (apostrophe drift); 000150 ships the loose-LIKE follow-up that actually rewrites the live bodies. Both are kept in source for fresh-replay correctness.
- **000152** — Dashboard Phase 1 schema. Adds `public_dashboard_projects` view (one-row-per-proof shape used by the redesigned dashboard), `dashboard_tile_counts()` SQL function for the four stat-tile counts in a single round-trip, and the first cut of `proofs_needing_attention()` returning `uuid[]` from two hardcoded rules (current version untouched for 3 working days; `last_activity_at` in the 25–30 day pre-dormant warning band). Also adds `designer_colour` / `designer_initials` columns on `profiles` with a backfill that pins Rob to `'blue'` and distributes other designers across `'teal'` / `'coral'` / `'purple'` via a stable hash of the profile id.
- **000153** — designer profile cleanup. Re-pins Rob's `'blue'` from the `rob.randtoul@gmail.com` account to `rob@plasmadesign.co.uk` (000152's email-based pin landed on the wrong account), sets Chris Jackson's `full_name` + `'teal'` colour, and moves Jack Johnson off `'teal'` to `'purple'` so two designers don't share a hue. Deletes the gmail-Rob and `test-designer@example.invalid` auth users; the 392 audit_log rows referencing gmail-Rob's `actor_id` survive intact via the existing `ON DELETE SET NULL` FK and the denormalised `actor_email` / `actor_label` columns that were written for exactly this case.
- **000154** — Needs-attention rules engine (Phase 2a). Adds `site_settings.needs_attention_rules` JSONB (six rules: `request_changes_no_version`, `helpscout_follow_up_tag`, `sent_never_viewed`, `viewed_not_actioned`, `approaching_dormant`, `stuck_in_progress`) and a `business_days_between(date, date)` helper. Replaces `proofs_needing_attention()` with a `(proof_id, rule_code, rule_meta)`-returning version that reads thresholds + priorities from settings and emits the highest-priority rule per proof. Extends `public_dashboard_projects` with `rule_code` / `rule_meta` columns so dashboard reason chips can render without a second query. Also adds `proofs.helpscout_tags text[]` as a placeholder for Phase 2b — the `helpscout_follow_up_tag` rule reads from it, but the array stays empty until the HS → DB tag sync ships.
- **000155** — `proof_pins` table backing the dashboard's Pinned (mine) and Team sections. Single table with `scope IN ('mine', 'team')`; partial unique indexes per scope (one mine-pin per proof per user, one team-pin per proof). RLS lets every authenticated designer read all pins, write/remove their own mine-pins, and write/remove team-pins. Deliberately not joined into `public_dashboard_projects` — pin state is fetched as a small standalone query and merged client-side, so pin churn doesn't force a full dashboard refetch.
- **000156** — capture live `profiles.helpscout_user_id` values into source so a fresh-replay no longer falls back to `HELPSCOUT_DEFAULT_USER_ID`. Uses `IS DISTINCT FROM <expected>` (the integer-correct equivalent of the loose-LIKE pattern from 000150) so re-running on a DB that already matches is a no-op. Pairs with the proof-action edge function's confirmation-reply work in 000157.
- **000157** — seed three `reply_templates` rows that the proof-action edge function resolves by code: `proof_approval_confirmation`, `proof_change_request_confirmation`, `proof_variant_selection_confirmation`. Help Scout never emails customer-thread messages back to the customer, so the edge function layers a staff reply on top of the existing customer-thread post and Help Scout emails THAT out. Default bodies mirror `src/lib/replyTemplates.ts` `DEFAULT_BODIES` so the admin editor's "Reset to default" button works. `ON CONFLICT (id) DO NOTHING` for safe replay.
- **000158** — `reopen_proof(p_proof_id uuid)` RPC. Atomic UPDATE of `proofs.status` to `in_progress` (also clearing `approved_at` / `abandoned_at`) plus DELETE of every `proof_name_approvals` row across the proof's versions. Fixes the bug where `handleReopen`'s client-side UPDATE left v1's `state='approved'` rows in place, so the v2 carry-forward block then INSERTed them onto v2 with `carried_from_version_id=v1` and the customer page treated v2 as pre-approved. Returns `integer` (count of cleared approvals) so the audit row carries a structured signal of how many approvals were wiped. SECURITY INVOKER — caller's RLS context is sufficient.
- **000163** — `proof_attention_snoozes` table. Columns: `id`, `proof_id` (FK proofs), `rule_code text`, `snoozed_by` (FK profiles — not auth.users, so initials/colour are joinable), `snoozed_at`, `snoozed_until`, `note text`. Unique index on `(proof_id, rule_code)` for upsert pattern. RLS: all authenticated users can read and manage snoozes.
- **000164** — wire snoozes into the rules engine and dashboard view. `proofs_needing_attention()` gains a `WHERE NOT EXISTS` guard that excludes any `(proof_id, rule_code)` pair with an active snooze — `dashboard_tile_counts()` picks this up automatically. `public_dashboard_projects` is dropped and recreated to add six snooze columns via a lateral join on `proof_attention_snoozes`: `snooze_rule_code`, `snoozed_until`, `snooze_note`, `snoozed_by_name`, `snoozed_by_initials`, `snoozed_by_colour` (longest-remaining active snooze per proof).

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

## Help Scout integration on the New project form

The `/proofs/new` form has two lookup mechanisms for linking a proof to a Help Scout conversation:

1. **URL-paste (primary, designer-initiated)** — designer pastes a conversation URL or numeric id into the "Start from Help Scout" field and clicks **Look up**. Hits the `lookup-helpscout-conversation` edge function with the parsed id. Populates the customer/contact/conversation fields from that specific conversation; the designer disambiguates upstream by copying the URL of the correct one.

2. **Email-driven (secondary, automatic)** — fires whenever `selectedContact.id` changes (whether the contact came from the URL-paste flow, manual contact-picker, or `?contactId=` URL param). Hits the `match-helpscout-conversation` edge function with the contact's email. Surfaces a multi-match picker when the email has multiple HS conversations; auto-applies on a single match; opens the override-reason panel on no matches. Filters out `closed`-status conversations on the HS side, so test fixtures with closed threads return zero matches even when the email has a real conversation history — easy to mistake for a missing feature during synthetic testing.

Both flows write to the same `helpscout_conversation_id` / `helpscout_conversation_url` fields on the proof. RLS keeps the columns designer-only.

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

Local dev: Rob runs `pnpm dev` in a separate terminal. Changes hot-reload so no deploy is needed to verify frontend work.

For DB migrations, the dry-run reflex applies:

1. **Always run `pnpm db:diff` first.** Read-only; lists every migration that's local-only (file exists in `supabase/migrations/` but hasn't been applied to the linked Supabase project). Quick gut-check before pushing.
2. **Push via `pnpm db:push:confirm`** rather than `npx supabase db push --include-all` directly. Same end result, but the script bails out if MORE than one migration is pending (a signal that the mixed-naming-convention set has drifted), prints what's about to be pushed, and asks for explicit "yes" confirmation. After pushing, it re-runs the list to confirm both sides are in sync.
3. The raw `npx supabase db push --include-all` is still available as an escape hatch — for example, when you've genuinely vetted multiple pending migrations and want to push them all. The script is the safety net you'd be bypassing.

## Working style

- Rob is a non-coder doing his first Claude Code project. Explain each step as you go, avoid jargon, don't assume knowledge of build tooling or SQL beyond the basics.
- Keep diffs focused and explainable — one feature per commit with a message that reads in plain English.
- Prefer tight, boring code over clever abstractions. When in doubt, match the existing pattern.
- Before claiming a feature is done, build (`npm run build`) to confirm types + bundle are clean. Skip `lint` unless there's a package.json script for it.
