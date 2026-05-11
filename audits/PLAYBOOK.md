# Bug Audit Playbook

This playbook drives the weekly automated audit of the proof viewer codebase. The scheduled task reads this file each run, so editing it changes future runs without touching the task itself.

Global business rules and voice rules live in `~/.claude/CLAUDE.md`. Repo-specific decisions and current schema state live in this repo's `CLAUDE.md` (the authoritative source). Memory entries in `~/Library/.../memory/MEMORY.md` capture lessons from previous bug fixes. All three are inputs; this playbook turns them into a recurring sweep.

> **Coverage refresh — 2026-05-11.** Migrations 000152 through 000170 added the redesigned designer dashboard (tile counts, needs-attention rules engine, pinned/team sections), the snooze system, the `public_get_customer_proof` anon-enumeration fix, the `reopen_proof` RPC, the three confirmation reply templates routed through the new `_shared/helpscout.ts`, self-service profile editing with avatar upload, and the QR-code workflow that gates per-recipient approvals. Three new areas (8 Dashboard rules engine, 9 Profile + avatar, 10 QR codes) cover that surface explicitly. Existing areas were tightened where the new code introduced new responsibilities (notably Help Scout's `_shared` extraction, the anon RPC pattern in Area 2, and the audit-action taxonomy in Area 5).

## Run shape

Each run dispatches ten parallel subagents, one per area. Each subagent returns a structured findings list. The orchestrator then:

1. Applies fixes that match the safe-list below to the working tree as file edits. No commit.
2. Applies all other proposed fixes to the working tree as file edits. No commit.
3. Writes the full triaged findings to `audits/latest-findings.json`. Each finding includes a `files` array listing exactly which paths it touched, so the ship prompt can commit each finding's files as its own commit.
4. Updates the Cowork dashboard artifact with the latest results.
5. Stops. The audit performs no git operations: no branch creation, no commits, no push, no PR.

The audit deliberately leaves the working tree dirty. The user runs a separate Monday-morning Code prompt (see "Shipping the audit") that reads the findings JSON and turns each finding's file list into its own commit on a fresh `bug-audit/YYYY-MM-DD` branch, then pushes and opens a PR.

This split exists because the Cowork sandbox can't reliably manage git locks: it creates `.git/index.lock` files during commits and the sandbox's own permissions sometimes prevent clearing them, leaving runs wedged. Two consecutive runs hit this failure mode (PV-2026W19 first attempt and PV-2026W19-R2). Moving git out of the sandbox eliminates the failure entirely.

If no findings are produced, the run still updates `latest-findings.json` with a timestamped empty result and refreshes the dashboard. No working-tree changes happen on a clean run.

The audit always reads from the state of `main`. If `main` isn't checked out at run start, the audit reports the wrong-branch state in the findings JSON and aborts cleanly without touching anything. Worktrees under `.claude/worktrees/` are ignored, since they may contain in-progress code that doesn't reflect shipped state.

If subagent dispatch errors at the platform level, the orchestrator falls back to inline area-by-area analysis in the same session and notes the fallback in the run metadata as `dispatch_mode: "inline_fallback"`. Coverage is narrower than parallel dispatch, but the run still produces real findings.

## Areas

Each area gets one subagent. The subagent reads the relevant files, the recent commit log for that area, and the listed business rules, then reports findings.

### Area 1: Pricing & VAT

Files:
- `src/lib/pricing/**`
- `src/components/quote/**`, `src/components/pricing/**`
- `supabase/migrations/**` (filter to migrations touching pricing tables, material_options, surcharges)
- `seed.sql`

Rules to check:
- GBP prices are VAT-inclusive; EUR and USD prices are VAT-free. No code path should add VAT to a non-GBP currency.
- No interpolation between listed quantity tiers. The quantity picker must constrain to values present in `price_tiers` for the chosen variant.
- `variant_type` is the variant-dimension discriminator (thickness | ink_count | finish | default). `material_options` is a separate dimension; do not conflate them.
- Standard Paper has three finish variants (`standard`, `uv_spot`, `foiling`) where the finish replaces the base price, not adds to it.
- Split-name tooling surcharges live on `materials`, per currency, per extra name beyond the first. Surcharge values:
  - Metal: £39 / €39 / $49
  - Translucent / tinted / satin plastic: £25 / €39 / $39
  - Full colour plastic: £15 / €25 / $25
  - Letterpress: £25 / €39 / $39
  - Acrylic / paper standard / carbon fibre / carbon fibre CNC: enabled in 000146; check live values per currency
- CMYK is included at no extra charge. Any reference to a CMYK upcharge is a bug.
- Satin and Translucent Plastic share one pricing schedule; divergence between them in the database is a bug.
- USD Copper is seeded from Gun Metal USD pricing.
- Custom-quote triggers: only NFC and unique-data orders trigger custom quotes. Edge colour, engraving, die-cut shape are free standard inclusions and must not trigger a custom quote.
- Letterpress is two material codes since migration 000098: `paper_letterpress` (no gilding) and `paper_letterpress_gilded`. Split-name tooling and pricing apply per code; treating letterpress as one material with a gilding flag is a bug.

### Area 2: Customer proof page & RLS

Files:
- `src/pages/CustomerProofPage.tsx`, `src/components/proof/**`, `src/components/QrCodePanel.tsx`
- `src/lib/supabase.ts`, `src/lib/publicSettings.ts`
- `supabase/migrations/**` (approval columns, public_* views, `public_get_customer_proof` RPC)
- View definitions for `public_proofs`, `public_proof_versions`, `public_proof_version_images`, `public_site_settings`, `public_material_options`, `public_material_option_surcharges`, `public_dashboard_projects`

Rules to check:
- Anon enumeration fix (000162): the customer page must read its full proof graph via the `public_get_customer_proof(p_proof_id uuid)` SECURITY DEFINER RPC, never via `supabase.from('public_*').select(...)` as anon. Any new anon-facing query against a `public_*` view or underlying table is a bug. See `proof_viewer_anon_rpc_pattern.md` memory.
- Every `public_*` view and the underlying tables they read from must carry `REVOKE FROM anon, public`. New views over RLS-protected tables that ship without the REVOKE are the failure mode 000148/000151/000162 caught; flag any view created without it.
- Views run as their owner so RLS on the underlying table doesn't gate them; the REVOKE rule above is how that's contained, not the table's RLS policy. Treat any "RLS protects this view" comment as suspect.
- When a migration adds or renames a column on an underlying table, the matching view must be dropped and recreated; PostgreSQL's `create or replace view` doesn't allow column reorder.
- The four approval columns on `proof_versions` are nullable schema prep. Code that reads them as non-null without a guard is a bug. `PublicProofVersion` in `src/lib/types.ts` includes them as optional, and drift here breaks the type contract.
- Per-direction-pricing rounds (000142/000144) have nullable `material_id` and `currency` on `proof_versions`. `PublicProofVersion.material_id` and `.currency` must be typed nullable (PV-2026W20-004). Any non-null read without an `is_per_direction_pricing` guard is a bug.
- Accepted enumeration risk: SELECT on contacts/companies/proofs is deliberately open. Don't propose closing without reading the designer-flow context (see `proof_viewer_rls.md` memory).
- The `maybe_finalize_proof_status()` trigger (000126) can flip a proof to approved on direct customer approval; never override `abandoned` or already-`approved`. Code paths that assume only the designer's "Mark as approved" button moves status are stale.
- The `reopen_proof(p_proof_id uuid)` RPC (000158) is the only correct path back from `approved` → `in_progress`: it atomically clears `approved_at` AND deletes every `proof_name_approvals` row across the proof's versions. Any client-side UPDATE on `proofs.status = 'in_progress'` that doesn't also wipe approvals is the bug 000158 fixed.
- `reopen_proof` returns `integer` (count of cleared approvals). Callers that swallow the RPC error silently (no `console.error`, no toast) are the PV-2026W19-007 antipattern; flag.
- Customer page view recording must skip authenticated sessions (post-2026-05-10 fix). A `record_proof_view` insert path that fires for designer previews pollutes the engagement signal.

### Area 3: Help Scout integration

Files:
- Anything calling `/v2/conversations/` or `/v2/customers/` endpoints
- `supabase/functions/_shared/helpscout.ts` (single canonical client)
- `supabase/functions/proof-action/index.ts`, `send-helpscout-reply`, `lookup-helpscout-conversation`, `match-helpscout-conversation`, `fetch-helpscout-conversation-context`, `admin-test-helpscout`
- `src/lib/helpscout.ts`, `src/lib/replyTemplates.ts`
- `src/pages/admin/AdminTemplatesSection.tsx` (admin reply-template editor)
- Conversation lookup flow on the new proof form

Rules to check:
- Use `helpscout-busybee` MCP tools for replies, notes, creating conversations. Do not fall back to the Zapier-based Help Scout tools.
- All HS HTTP calls in edge functions must go through `_shared/helpscout.ts` helpers (`getAccessToken`, `fetchConversation`, `fetchConversationOwnership`, `postStaffReply`, `fetchCustomer`). Per-function `HsError` classes or inline `getAccessToken` duplicates are the PV-2026W19-017 / PV-2026W20-008 antipattern. The two deliberate stay-locals are `POST /v2/conversations/{id}/customer` (proof-action only) and the threads-embed shape in `fetch-helpscout-conversation-context`; everything else extracted.
- Errors from `_shared` helpers are `HsError` instances carrying `status`. Callers that catch plain `Error` and stringify will miss the structured status code. The inline `fetchConversationWithThreads` still throws plain `Error` and is the standing PV-2026W20-009 follow-up; flag any new helper that doesn't throw `HsError`.
- Help Scout signature is appended automatically. Replies must not include a sign-off. This applies to seeded reply templates as well as ad-hoc messages, including any default body text seeded via migration. (PV-2026W19-001 surfaced templates that violated this rule and reached production.)
- Use `<br><br>` between paragraphs in Help Scout HTML, not `<p>` alone. `<p>` renders with no visible gap.
- Bullet lists with `<ul><li>` render fine.
- `POST /v2/conversations/{id}/customer` returns the new thread ID in the `Resource-Id` header, not `Location` (unlike `/reply`). The both-header parser is the safe shape; any code reading only one header is a bug. `postStaffReply` in `_shared` uses the safe parser; the inline `hsPostCustomerThread` in proof-action must match it.
- Conversation URL is captured on every proof. When an email matches multiple Help Scout conversations, the designer picks from a list. Bypassing that pick step is a bug.
- Three confirmation reply templates are resolved by code by the proof-action edge function via 000157: `proof_approval_confirmation`, `proof_change_request_confirmation`, `proof_variant_selection_confirmation`. The `DEFAULT_BODIES` map in `src/lib/replyTemplates.ts` must mirror the seeded bodies in 000157 so the admin editor's "Reset to default" button works. Any drift between the two is a bug.
- The proof-action edge function emits a designer confirmation reply via `postStaffReply` because Help Scout doesn't email customer-thread messages back to the customer; the staff reply on top is what triggers the email. Removing the staff reply layer breaks customer notification.
- Manual HS URL paste must accept an optional trailing slash (PV-2026W20-002 fix). Tighter parsers reject valid URLs.
- The `helpscout_link_set` audit row must source the URL from the `pasteWasUsed` flag, not the URL itself (PV-2026W20-001 fix), or the audit log can't tell URL-paste from email-match resolution.

### Area 4: Variant rounds

Files:
- Anything touching `__shared__` naming
- Variant emission code
- `request_changes` flow
- Per-direction-pricing (renamed from mixed-materials) sub-mode
- `supabase/functions/proof-action/index.ts` (server-side lock enforcement, lines around the `round_variant_id` validation block)
- `src/components/VersionDetailModal.tsx`, `src/pages/NewVersionPage.tsx` (inheritance + docket gating)

Rules to check:
- `request_changes`-only emission. Variant rounds must not emit on approve.
- `__shared__` is the canonical naming for assets shared across variants.
- Lock-on-selection is enforced server-side in the proof-action edge function (PV-2026W19-014 fix): the function pre-checks for any existing approval row with a non-null `round_variant_id` on the parent version's versions and rejects with `'this variant round has already been locked by a customer selection'` if found. Client-only lock logic is the pre-fix shape and a bug.
- Codes are write-once. Any path that overwrites a variant code is a bug.
- Per-variant sides: maximum 2 sides per variant.
- Per-direction-pricing hides the docket entirely. UI showing the docket while per-direction pricing is on is a bug. The VersionDetailModal docket fix landed under PV-2026W20-010; regressions are flag-worthy.
- Per-direction-pricing version save must not be blocked by currency/material required-field validation (PV-2026W20-007). The save path needs an explicit `is_per_direction_pricing` branch that skips those guards.
- NewVersionPage inheritance from a per-direction-pricing v(N-1) must NOT hydrate `currency` or `material_id` onto the new draft (PV-2026W19-009 fix). Inheritance code paths that blindly copy these fields are the bug.
- Variant-round version creation must call `logAudit` for the `version.added` event (PV-2026W19-013). A save path that skips the audit row while the standard save path writes one is a stale code path.

### Area 5: Admin / Designer dashboard

Files:
- `src/pages/DashboardPage.tsx`, `src/lib/dashboardGrouping.ts`, `src/components/EditProfileModal.tsx`
- `src/pages/admin/**`, `src/pages/admin/auditFilters.ts`, `src/pages/admin/AdminNeedsAttentionPage.tsx`
- Audit log writes
- `dashboard_latest_events`, `public_dashboard_projects`, `dashboard_tile_counts()` consumers

Rules to check:
- Admin pricing pages prefer direct supabase insert + single audit-log event, not the `apply_pricing_updates` RPC. The RPC is reserved for multi-table batch ops like CSV import.
- The `apply_pricing_updates` RPC arms include `materials_added`, `variants_added`, `price_tier_created`, `add_on_prices_updated`. Code paths that don't handle every arm are stale.
- `archived_at` cascades RLS across `materials` / `material_variants` / `price_tiers`. Direct delete should use the archive flow instead.
- The `dashboard_latest_events` view (000127) UNIONs synthetic `event_type='view'` rows from `proof_version_views`. The CHECK constraint on `proof_events.event_type` does NOT include 'view'. Any insert of a 'view' row directly into `proof_events` is a bug.
- The `auditFilters.ts` `ACTION_GROUPS` list is the canonical taxonomy. Every code the audit log can emit must appear there. Codes added since 2026-05-08 that must be present: `proof.snoozed`, `proof.unsnoozed`, `setting.team_pin_added`, `setting.team_pin_removed`, `setting.needs_attention_rules_updated`, plus the `setting.*` reply-template codes. PV-2026W19-010 closed the first batch; PV-2026W20-013 added snooze. Flag any new audit emit that's not in the taxonomy.
- Tile counts and click-through filter predicates must share a definition. The PV-2026W19-015 / PV-2026W20-014 / PV-2026W20-005 lineage caught tile counts (Awaiting customer, Dormant, Approved this week) drifting from the row filter on the same column. After 000170 the dashboard sources every tile count client-side against the `public_dashboard_projects` rows; any new SQL-side tile-count column on the view, or any new tile that ships with a separate predicate from the row filter, is the bug.
- Dashboard reads from `public_dashboard_projects` and merges `proof_pins` client-side (deliberate, because pin churn shouldn't force a full dashboard refetch). Code joining `proof_pins` into the view is the wrong shape.
- The needs-attention pipeline:
  - `site_settings.needs_attention_rules` JSONB stores the six rules. The shape is `{ enabled, threshold_days?, calendar?, priority }` per rule. The `RULE_SPECS` array in `AdminNeedsAttentionPage.tsx` is the source of truth for which rules support which fields. Drift between it and the live JSONB is a flag.
  - `proofs_needing_attention()` returns `(proof_id, rule_code, rule_meta)` and emits the highest-priority rule per proof. `public_dashboard_projects.rule_code` / `.rule_meta` mirror it so dashboard reason chips render without a second query.
  - `business_days_between(start, end)` is inclusive at end (000160). Any threshold predicate that subtracts a day to compensate is the pre-000160 shape and a bug.
  - Active snoozes exclude `(proof_id, rule_code)` pairs from `proofs_needing_attention()` (000164). The dashboard view's six snooze columns (`snooze_rule_code`, `snoozed_until`, `snooze_note`, `snoozed_by_name`, `snoozed_by_initials`, `snoozed_by_colour`) all need to flow through together; any partial set is drift.
  - The "Snoozed" tile filter must hide snoozed rows by default in the rest of the dashboard. Show-snoozed toggle reveals them; clicking the Snoozed tile filters to snoozed-only.
- `helpscout_follow_up_tag` rule reads from `proofs.helpscout_tags text[]` (000154). Until the HS-tag-sync ships, the array stays empty. Code that assumes the array is always populated is a stale Phase 2b assumption.

### Area 6: Supabase migrations & schema integrity

Files:
- `supabase/migrations/**`
- `supabase/seed.sql`
- Type definitions in `src/lib/types.ts` and generated types

Rules to check:
- Mixed numbering: migrations use both `000xxx` and `20260419xxx` styles. `db push` requires `--include-all`. Any docs or scripts that say to run plain `db push` are stale.
- View ownership leak: any new view over an RLS-protected table needs `REVOKE FROM anon, public`. (PV-2026W19-002 surfaced 000148 missing this; 000151 retroactively closed it.)
- Schema state lives in seed + migrations together. Never reason about whether a code/column/row exists from seed.sql alone; migrations add changes after the seed and are authoritative.
- Supabase RPC return values are thenable. `void` on `supabase.rpc(...)` silently drops the fetch. Always `.then()` or `await`.
- Postgres UPDATE-FROM scoping: target table can't be referenced in a JOIN's ON clause inside FROM. Single-table FROM with a pre-joined CTE, or cross-join with predicate in WHERE.
- Placeholder variants can be `is_active=true` with zero `price_tiers` rows as a forward-compat hook. New surfaces must decide how to handle the empty case.
- Letterpress paper stock is Colorplan (GF Smith). Customer-facing copy should say "Colorplan paper" not generic descriptors.
- When proposing a migration that updates existing rows, query live DB state first (via service-role key from `.env` if available) to confirm the WHERE clause matches at least one row. If the strict-equality pattern matches zero live rows, write a loose pattern (LIKE / regex_replace) instead. Migration 000149 (PV-2026W19-001) shipped with strict equality and matched zero live rows because the bodies had drifted, so loose follow-up 000150 had to ship as a separate PR. Avoid the round-trip: read the live data, write the WHERE clause to match.
- Numbering a new migration: always `ls supabase/migrations/` and pick `max(NNNNNN) + 1`. CLAUDE.md's migration head can lag (it's a curated highlight reel; see `feedback_proof_viewer_claude_md_migration_log_curated.md`). The dashboard renumber PRs #59/#60/#61 happened because a migration was numbered from the doc rather than the directory; flag any new migration whose number isn't directory-max + 1.
- Audit-attribution columns (`pinned_by`, `snoozed_by`, any future `*_by`) must carry a `WITH CHECK <column> = auth.uid()` on insert/update policies. The 000159 (proof_pins) and 000167 (proof_attention_snoozes) pattern is the canonical shape; a permissive `with check (true)` on any shared-state table is the PV-2026W19-011 / PV-2026W20-019 antipattern.

### Area 7: Source-of-truth coherence

This area runs without source-tree access, so it always succeeds even if the repo is in an unusual state.

Files:
- This repo's `CLAUDE.md`
- `~/.claude/CLAUDE.md` (global business rules; check for drift against project-level rules)
- `~/Library/.../memory/MEMORY.md` and the memory files it indexes
- `audits/latest-findings.json` from the previous run

Rules to check:
- `CLAUDE.md` lists current migration head. Compare against the real head: `ls supabase/migrations/ | sort -r | head -1`. If they disagree, flag.
- Global `~/.claude/CLAUDE.md` pricing rules should enumerate all materials with split-name surcharges (per the Area 1 list). Missing material families are drift; flag.
- Memory entries that reference specific migration numbers, material codes, or table columns. Each one should still be true on the live schema. Sample-check by grepping the migrations folder.
- Memory entries describing decisions or rules. Each should still match what `CLAUDE.md` says, or `CLAUDE.md` should be updated. The two are meant to agree on intent.
- The previous run's findings list. Any P1/P2 finding marked `proposed` from the prior run that hasn't been merged or dismissed is stale and should be re-flagged.
- The recently-added memory entries that codify project patterns (e.g. `proof_viewer_anon_rpc_pattern.md`, `feedback_proof_viewer_claude_md_migration_log_curated.md`, `feedback_check_migrations_dir_before_numbering.md`) should each map to a rule in this playbook. If a memory entry isn't reflected anywhere here, either propose a playbook addition or retire the memory; drift between them defeats the point.

### Area 8: Dashboard rules engine, pins, snoozes

Files:
- `src/pages/DashboardPage.tsx`
- `src/lib/dashboardGrouping.ts` (+ `.test.ts`)
- `src/pages/admin/AdminNeedsAttentionPage.tsx`
- `supabase/migrations/000152_dashboard_phase_1.sql`, `000154_needs_attention_rules.sql`, `000155_proof_pins.sql`, `000159_proof_pins_pinned_by_self.sql`, `000160_business_days_between_inclusive_at_end.sql`, `000161_public_dashboard_projects_awaiting_customer.sql`, `000163_proof_attention_snoozes.sql`, `000164_snooze_rules_and_dashboard.sql`, `000167_proof_attention_snoozes_snoozed_by_self.sql`, `000170_drop_awaiting_customer_from_dashboard.sql`

Rules to check:
- `proof_pins.pinned_by` and `proof_attention_snoozes.snoozed_by` insert/update policies must include `WITH CHECK (<col> = auth.uid() OR <col> IS NULL)`. The `IS NULL` branch is defensive (FK ON DELETE SET NULL leaves the column nullable). A `WITH CHECK (true)` on either is the spoofable shape that 000159 and 000167 closed.
- DELETE policies on pins and snoozes are intentionally open, so any designer can clear a colleague's team-pin or unsnooze a colleague's snooze. Don't tighten without explicit product sign-off.
- Pin scope is two values: `'mine'` and `'team'`. Partial unique indexes enforce one mine-pin per (proof, user) and one team-pin per proof. Adding a third scope without backfilling the indexes is a bug.
- Snooze popover state must reset between rows (PV-2026W20-017). Stale `customDate` / `hours` leaking from a previous row's popover into a new row's popover is the bug.
- The snooze row writes `snoozed_by = auth.uid()` client-side (the happy path), and 000167 enforces it server-side. Code that omits the field and relies on a server default is a stale shape.
- `business_days_between(start, end)` is inclusive at end (000160). The dashboard predicates and the `proofs_needing_attention()` rule body both rely on this; any reimplementation in JS or SQL must follow the same convention.
- "Show snoozed" toggle defaults off. The Snoozed tile click sets a filter to snoozed-only and its count is unaffected by other tile filters.
- Dormant and Approved-this-week tile counts must be derived from `public_dashboard_projects` rows client-side (post-PV-2026W20-014). SQL-side counts that re-implement the predicate are forbidden; 000170 removed the last drifted column.
- Latest Activity sidebar caps at 20 rows (post-000127). View synthesis is deduped to first view per (version_id, day); regressions to one row per view event are bugs.
- The needs-attention reason chip on dashboard rows reads `rule_code` + `rule_meta` from the project row. When the needs-attention tile filter is active, the inline reason text must render on each row (2026-05-11 feature). Filter-active rows without an inline reason are stale.
- Pin icon visual state: filled + violet background when active; bordered when inactive. Action-strip layout reserves space for both, so width must not jitter on toggle (the abandoned-toggle width-jitter fix on 2026-05-10 sets the precedent).
- `EditProfileModal` is the only path for designer self-edit of name/initials/colour/avatar (see Area 9). Dashboard header avatar updates must reflect a `Remove photo` action immediately (PV-2026W20-018 fix).

### Area 9: Profile self-edit and avatars

Files:
- `src/components/EditProfileModal.tsx`
- `supabase/migrations/000153_designer_profile_cleanup.sql`, `000165_profile_self_edit.sql`, `000166_profile_avatar.sql`

Rules to check:
- The owner-update RLS policy on `profiles` (000165) carries a `WITH CHECK` that asserts the proposed `role` matches the currently-stored value via a self-subquery. Designers must NOT be able to flip their own role from `designer` to `admin` via a direct API call. Any RLS edit that loosens this is a P1 security regression.
- Avatars storage bucket is public with a 2 MB cap and an allow-list of `image/jpeg`, `image/png`, `image/webp`. Bucket RLS gates insert/update/delete on `auth.uid()::text = (storage.foldername(name))[1]`, so paths must be keyed on `{user_id}/avatar`. Code that writes to any other path shape is a bug.
- Client-side validation in `EditProfileModal` mirrors the storage RLS: `ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']` and `MAX_BYTES = 2 * 1024 * 1024`. Drift between client and storage policy is a flag.
- Avatar upload uses `upsert: true` against the same `{user_id}/avatar` path so old files don't leak. A cache-buster query-string (`?t=${Date.now()}`) is appended to the persisted `avatar_url` so browsers fetch the latest. Missing cache-buster = stale avatars after re-upload.
- `public_dashboard_projects` exposes `designer_avatar_url` (000166) directly after `designer_colour`. Removing or reordering that column without dropping and recreating the view will break the dashboard.
- Designer-colour catalogue is exactly four values: `blue`, `teal`, `coral`, `purple`. Adding a fifth value without extending the `EditProfileModal` `COLOURS` array, the `DesignerColour` type, and the colour-meta lookup everywhere it's used is the bug.
- Auto-derived initials are `name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()`. The user-edited flag suppresses auto-derive after manual entry. Any code path that overwrites manually-edited initials on name change is a regression.
- Profile edits should write an audit row (rules engine emits via `setting.*` codes elsewhere). At time of last audit, `EditProfileModal` had no `logAudit` call; flag as a P3 gap unless product has explicitly opted out.

### Area 10: QR codes

Files:
- `src/lib/qrCodes.ts` (+ `.test.ts`)
- `src/components/QrCodeUploadSection.tsx`, `src/components/QrCodePanel.tsx`
- `src/pages/NewVersionPage.tsx`, `src/pages/EditVersionPage.tsx` (upload pipeline + carry-forward)
- `src/pages/CustomerProofPage.tsx` (QR panel + confirmation tick gate)
- `supabase/functions/proof-action/index.ts` (server-side QR gate)
- `supabase/migrations/000168_proof_version_images_qr_fields.sql`, `000169_qr_confirmation_on_approvals.sql`

Rules to check:
- The `proof_version_images_qr_consistency_chk` CHECK constraint enforces: `is_qr_code = true` IFF both `qr_decoded_data` and `qr_kind` are populated. Non-QR rows must have both as null. Any insert path that writes one without the other will fail the CHECK; flag callers building partial rows.
- `qr_kind` is constrained to the classifier's eight outputs: `vcard`, `url`, `wifi`, `mecard`, `email`, `phone`, `sms`, `text`. New kinds added in `classifyQrData()` without extending the CHECK constraint will fail inserts.
- `classifyQrData` order matters: vCard / MeCard / wifi prefixes are byte-strict and must be checked before URL/email/phone/sms. Reordering the cascade can mis-classify wrapped vCard payloads as URLs.
- jsQR is dynamically imported inside `decodeQrFromFile` so the pure-string parsers can be unit-tested without jsqr installed. Any code that imports jsqr at module scope kills the test runner.
- `QrDecodeError` is the canonical "image isn't a QR" exception. The UI surfaces it as a rose-toned "Couldn't read a QR code in this image" message; the customer never sees an undecodable JPEG. Code that swallows `QrDecodeError` silently is the bug.
- The customer-page QR confirmation tick (`qr_confirmed_at` on `proof_name_approvals`) gates approval ONLY when the slot has at least one QR row on the current version. No QRs → tick isn't shown → null `qr_confirmed_at` is fine. The slot-coordinates predicate must match `_finalize_proof_if_complete`:
  - Named slot: rows where `is_qr_code = true AND (associated_name = <slot> OR associated_name IS NULL)`.
  - `__shared__` when `names[]` is empty: every QR row.
  - `__shared__` on a split-name version: NOT gated (the sentinel is approved-by-implication and the customer page hides the tick).
- The proof-action edge function mirrors the predicate server-side. Approving with an unticked QR set via direct API must be rejected by the function, not just by the disabled-button UI. Any new server entry point that writes a `state='approved'` row without checking `qr_confirmed_at` is a bug.
- Variant rounds skip the QR gate entirely (the 000141 `maybe_finalize_proof_status` guard already bails at the top for variant rounds). Code that gates a variant-round selection on QR confirmation is wrong.
- Carry-forward: a changed QR is a changed file → changed storage path → broken carry-forward identity. NewVersionPage's carry-forward block must write `qr_confirmed_at` from the v1 row into the carried v2 row so the customer doesn't have to re-tick on objectively-unchanged QRs. Any new carry path that ignores the column re-introduces the re-tick bug.
- The designer's "Mark as approved" override path must stamp `qr_confirmed_at = now()` server-side on the rows it creates (or it falls into the same null-blocks-finalize trap as a customer with an unticked box).
- `public_proof_version_images` view exposes `is_qr_code`, `qr_decoded_data`, `qr_kind`. The view is `REVOKE FROM anon` per the 000162 pattern; customer-page reads of QR data flow through `public_get_customer_proof` (Area 2).
- The customer-page QR panel splits rendering on `is_qr_code`: the existing image grid stays on `is_qr_code = false`, the QR panel reads `is_qr_code = true`. Any image-grid query that doesn't filter `is_qr_code = false` leaks QR JPEGs into the artwork grid.

## Auto-fix safe-list

Findings flagged `auto_applied: true` are safe enough that the user can ship them with minimal review. Findings flagged `auto_applied: false` are proposed and should be reviewed carefully. Both end up as commits on the bug-audit branch via the ship-audit prompt; the distinction is purely about review depth, not git mechanics.

Eligible for `auto_applied: true`:
- British English typos in user-facing strings (`color` to `colour`, `customize` to `customise` in copy).
- Unused imports (no other code references the symbol in the file).
- Unreferenced exports with no external consumers (verify via repo-wide grep first).
- Missing null/undefined guards on values whose type already includes `null` or `undefined`.
- Lint violations with established auto-fixers (ESLint `--fix`, Prettier formatting).
- Stale TODO comments where the referenced ticket is closed or the work is shipped.
- Comment typos (no semantic content).
- Dead `console.log` left from debugging (not structured logging).

NOT eligible for `auto_applied: true` (always `auto_applied: false`):
- Anything in `supabase/migrations/` or `supabase/seed.sql`.
- Anything touching pricing logic, surcharges, VAT, currency.
- RLS policies, view definitions, grants.
- Help Scout API calls or response parsing.
- Auth or session flow.
- Function signature changes (params, return types).
- Database queries (SELECT, UPDATE, DELETE, RPC calls).
- Routing or URL changes.
- Anything in the customer proof page approval flow.
- React component prop interface changes.
- Type definitions in `src/lib/types.ts`.
- Edits to `CLAUDE.md` or memory files (these are reasoning surfaces; humans confirm).
- Anything in the QR decode / classify / confirmation gate pipeline (Area 10), because wrong classification or a swallowed gate is a real-money print bug.
- Profile role-immutability `WITH CHECK` (Area 9), where loosening it is a privilege-escalation path.
- Audit-attribution `WITH CHECK` on `pinned_by` / `snoozed_by` (Area 8), where touching them re-opens spoofing.
- The auto-fix safelist itself; adding categories without explicit human review defeats the safety net.

When in doubt, flag `auto_applied: false`. The cost of a missed safe flag is a slightly more careful review. The cost of a wrong safe flag on a pricing surcharge is a real-money customer issue.

## Severity classification

- **P1**: data corruption risk, security exposure, customer-visible breakage, money calculations wrong by a non-trivial amount.
- **P2**: workflow logic bug, wrong calculation in an edge case, missing null check on a real-world path, stale rule that diverges from CLAUDE.md.
- **P3**: UX or cosmetic issue, dead code, comment drift, minor inconsistency, lint debt.

## Output format

Each finding is a JSON object:

```json
{
  "id": "PV-2026W19-001",
  "area": "pricing",
  "severity": "P2",
  "title": "Quantity picker allows interpolated tiers for Translucent",
  "description": "...",
  "files": ["src/components/quote/QuantityPicker.tsx"],
  "lines": [142, 158],
  "proposed_fix": "...",
  "auto_applied": false,
  "rule_violated": "No interpolation between listed quantity tiers",
  "rule_source": "CLAUDE.md / pricing schema"
}
```

The `id` format is `PV-YYYYWww-NNN` where `ww` is the ISO week number. This makes findings sortable and uniquely traceable across runs. Re-runs in the same week use the suffix `-Rn` (e.g. `PV-2026W19-R2`) on the run ID itself; finding IDs continue numbering from the previous week's last index.

The `files` array is what the ship-audit prompt uses to construct per-finding commits. Each finding's listed files become one commit.

## Shipping the audit

After each weekly run, the audit leaves a dirty working tree on `main` with edits matching the findings in `audits/latest-findings.json`. Pushing those changes upstream is a human-driven Code session.

The standard Monday-morning Code prompt:

```
Ship the latest weekly bug audit findings.

1. cd /Users/robrandtoul/proof-viewer
2. Read audits/latest-findings.json. Report the run_id, total findings, severity counts, and the next_action field.
3. git status. The status should show modified or new files matching the union of all findings' `files` arrays in the JSON. If anything's missing or any unexpected file is dirty (other than the known untracked logo file), stop and tell me before proceeding.
4. Show me the diff for the entire working tree. I'll review.
5. Once I confirm, create a fresh bug-audit branch from main:
   git checkout -b bug-audit/YYYY-MM-DD
   (Use today's date. If a same-day branch already exists, suffix with -2, -3.)
6. For each finding in the JSON, commit its files separately:
   - For findings with auto_applied=true:
       git add <files for that finding>
       git commit -m "fix(audit): <title> [<id>]"
   - For findings with auto_applied=false:
       git add <files for that finding>
       git commit -m "[proposed] <title> [<id>]"
7. Push the branch:
   git push -u origin bug-audit/YYYY-MM-DD
8. Open the PR:
   gh pr create --base main --head bug-audit/YYYY-MM-DD \
     --title "Bug audit: <run_id>" \
     --body "<summary from the findings JSON: severity counts and one line per finding>"
9. Report the PR URL. I'll merge via gh pr merge --merge or via the browser.

For migration commits, do not apply via pnpm db:diff / pnpm db:push:confirm until after the PR merges and main is updated.

Stop after step 9.
```

Save this prompt as a Code slash command if you have a way to do that, otherwise just keep this section open Monday morning and copy from here.

Never push to `main` directly. The repo guardrail blocks it; that's by design. Always go through a PR.

## Updating the playbook

After a run, if a new pattern emerged that should be checked next time, add it to the relevant area. If the run produced false positives, tighten the rule. The playbook gets sharper every run; that's the whole point.
