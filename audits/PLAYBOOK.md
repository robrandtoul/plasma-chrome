# Bug Audit Playbook

This playbook drives the weekly automated audit of the proof viewer codebase. The scheduled task reads this file each run, so editing it changes future runs without touching the task itself.

Global business rules and voice rules live in `~/.claude/CLAUDE.md`. Repo-specific decisions and current schema state live in this repo's `CLAUDE.md` (the authoritative source). Memory entries in `~/Library/.../memory/MEMORY.md` capture lessons from previous bug fixes. All three are inputs; this playbook turns them into a recurring sweep.

## Run shape

Each run dispatches seven parallel subagents, one per area. Each subagent returns a structured findings list. The orchestrator then:

1. Auto-applies fixes that match the safe-list below to a branch named `bug-audit/YYYY-MM-DD`.
2. Stages all other proposed fixes as commits on the same branch with `[proposed]` prefixes.
3. Opens a draft PR with a triaged summary.
4. Updates `audits/latest-findings.json` with the full triage.
5. Updates the Cowork dashboard artifact with the latest results.

If no findings are produced, the run still updates `latest-findings.json` with a timestamped empty result and refreshes the dashboard. No PR is opened on a clean run.

The audit always runs against `main`. Worktrees under `.claude/worktrees/` are ignored, since they may contain in-progress code that doesn't reflect shipped state. Per the worktree-trap memory, `pwd` can lie about which worktree is current; the task verifies it's on `main` before dispatching subagents.

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
- CMYK is included at no extra charge. Any reference to a CMYK upcharge is a bug.
- Satin and Translucent Plastic share one pricing schedule; divergence between them in the database is a bug.
- USD Copper is seeded from Gun Metal USD pricing.
- Custom-quote triggers: only NFC and unique-data orders trigger custom quotes. Edge colour, engraving, die-cut shape are free standard inclusions and must not trigger a custom quote.
- Letterpress is two material codes since migration 000098: `paper_letterpress` (no gilding) and `paper_letterpress_gilded`. Split-name tooling and pricing apply per code; treating letterpress as one material with a gilding flag is a bug.

### Area 2: Customer proof page & RLS

Files:
- `src/pages/proof/**`, `src/components/proof/**`
- `src/lib/supabase/**` (public-proof helpers)
- `supabase/migrations/**` (approval columns, public_* views)
- View definitions for `public_proofs`, `public_proof_versions`, `public_proof_version_images`, `public_site_settings`, `public_material_options`, `public_material_option_surcharges`

Rules to check:
- Phase 1 is read-only. Approve UI should not be wired up unless Phase 2 is explicitly active.
- The four approval columns on `proof_versions` are nullable schema prep. Code that reads them as non-null without a guard is a bug.
- `PublicProofVersion` type in `src/lib/types.ts` includes the four approval fields as optional. Drift here breaks the type contract.
- The customer page reads from `public_*` views. Views run as their owner so RLS on the underlying table doesn't gate them. Any new view over an RLS-protected table must explicitly `REVOKE FROM anon, public`.
- When a migration adds or renames a column on an underlying table, the matching view must be dropped and recreated; PostgreSQL's `create or replace view` doesn't allow column reorder.
- Accepted enumeration risk: SELECT on contacts/companies/proofs is deliberately open. Don't propose closing without reading the designer-flow context (see `proof_viewer_rls.md` memory).
- The `maybe_finalize_proof_status()` trigger (000126) can flip a proof to approved on direct customer approval; never override `abandoned` or already-`approved`. Code paths that assume only the designer's "Mark as approved" button moves status are stale.

### Area 3: Help Scout integration

Files:
- Anything calling `/v2/conversations/` endpoints
- `src/lib/helpscout/**` and edge functions
- Conversation lookup flow on the new proof form

Rules to check:
- Use `helpscout-busybee` MCP tools for replies, notes, creating conversations. Do not fall back to the Zapier-based Help Scout tools.
- Help Scout signature is appended automatically. Replies must not include a sign-off.
- Use `<br><br>` between paragraphs in Help Scout HTML, not `<p>` alone. `<p>` renders with no visible gap.
- Bullet lists with `<ul><li>` render fine.
- `POST /v2/conversations/{id}/customer` returns the new thread ID in the `Resource-Id` header, not `Location`. The both-header parser is the safe shape; any code reading only one header is a bug.
- Conversation URL is captured on every proof. When an email matches multiple Help Scout conversations, the designer picks from a list. Bypassing that pick step is a bug.

### Area 4: Variant rounds

Files:
- Anything touching `__shared__` naming
- Variant emission code
- `request_changes` flow
- Per-direction-pricing (renamed from mixed-materials) sub-mode

Rules to check:
- `request_changes`-only emission. Variant rounds must not emit on approve.
- `__shared__` is the canonical naming for assets shared across variants.
- Lock-on-selection: once a variant is selected by the customer, the variant set is locked.
- Codes are write-once. Any path that overwrites a variant code is a bug.
- Per-variant sides: maximum 2 sides per variant.
- Per-direction-pricing hides the docket entirely. UI showing the docket while per-direction pricing is on is a bug.

### Area 5: Admin / Designer dashboard

Files:
- `src/pages/admin/**`, `src/components/admin/**`
- Audit log writes
- `dashboard_latest_events` view consumers

Rules to check:
- Admin pricing pages prefer direct supabase insert + single audit-log event, not the `apply_pricing_updates` RPC. The RPC is reserved for multi-table batch ops like CSV import.
- The `apply_pricing_updates` RPC arms include `materials_added`, `variants_added`, `price_tier_created`, `add_on_prices_updated`. Code paths that don't handle every arm are stale.
- `archived_at` cascades RLS across `materials` / `material_variants` / `price_tiers`. Direct delete should use the archive flow instead.
- The `dashboard_latest_events` view (000127) UNIONs synthetic `event_type='view'` rows from `proof_version_views`. The CHECK constraint on `proof_events.event_type` does NOT include 'view'. Any insert of a 'view' row directly into `proof_events` is a bug.

### Area 6: Supabase migrations & schema integrity

Files:
- `supabase/migrations/**`
- `supabase/seed.sql`
- Type definitions in `src/lib/types.ts` and generated types

Rules to check:
- Mixed numbering: migrations use both `000xxx` and `20260419xxx` styles. `db push` requires `--include-all`. Any docs or scripts that say to run plain `db push` are stale.
- View ownership leak: any new view over an RLS-protected table needs `REVOKE FROM anon, public`.
- Schema state lives in seed + migrations together. Never reason about whether a code/column/row exists from seed.sql alone; migrations add changes after the seed and are authoritative.
- Supabase RPC return values are thenable. `void` on `supabase.rpc(...)` silently drops the fetch. Always `.then()` or `await`.
- Postgres UPDATE-FROM scoping: target table can't be referenced in a JOIN's ON clause inside FROM. Single-table FROM with a pre-joined CTE, or cross-join with predicate in WHERE.
- Placeholder variants can be `is_active=true` with zero `price_tiers` rows as a forward-compat hook. New surfaces must decide how to handle the empty case.
- Letterpress paper stock is Colorplan (GF Smith). Customer-facing copy should say "Colorplan paper" not generic descriptors.

### Area 7: Source-of-truth coherence

This area runs without source-tree access, so it always succeeds even if the repo is in an unusual state.

Files:
- This repo's `CLAUDE.md`
- `~/Library/.../memory/MEMORY.md` and the memory files it indexes
- `audits/latest-findings.json` from the previous run

Rules to check:
- `CLAUDE.md` lists current migration head. Compare against the real head: `ls supabase/migrations/ | sort -r | head -1`. If they disagree, flag.
- Memory entries that reference specific migration numbers, material codes, or table columns. Each one should still be true on the live schema. Sample-check by grepping the migrations folder.
- Memory entries describing decisions or rules. Each should still match what `CLAUDE.md` says, or `CLAUDE.md` should be updated. The two are meant to agree on intent.
- The previous run's findings list. Any P1/P2 finding marked `proposed` from the prior run that hasn't been merged or dismissed is stale and should be re-flagged.

## Auto-fix safe-list

Only these categories are eligible for auto-commit. Everything else is staged as a `[proposed]` commit on the same branch for human review.

Safe to auto-apply:
- British English typos in user-facing strings (`color` to `colour`, `customize` to `customise` in copy).
- Unused imports (no other code references the symbol in the file).
- Unreferenced exports with no external consumers (verify via repo-wide grep first).
- Missing null/undefined guards on values whose type already includes `null` or `undefined`.
- Lint violations with established auto-fixers (ESLint `--fix`, Prettier formatting).
- Stale TODO comments where the referenced ticket is closed or the work is shipped.
- Comment typos (no semantic content).
- Dead `console.log` left from debugging (not structured logging).

NOT safe to auto-apply (always becomes a `[proposed]` commit):
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

When in doubt, propose. The cost of a missed auto-fix is one extra click on a PR. The cost of a wrong auto-fix to a pricing surcharge is a real-money customer issue.

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
  "fix_safety": "propose",
  "rule_violated": "No interpolation between listed quantity tiers",
  "rule_source": "CLAUDE.md / pricing schema"
}
```

The `id` format is `PV-YYYYWww-NNN` where `ww` is the ISO week number. This makes findings sortable and uniquely traceable across runs.

## Updating the playbook

After a run, if a new pattern emerged that should be checked next time, add it to the relevant area. If the run produced false positives, tighten the rule. The playbook gets sharper every run; that's the whole point.
