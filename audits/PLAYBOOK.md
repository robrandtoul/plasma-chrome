# Bug Audit Playbook

This playbook drives the weekly automated audit of the proof viewer codebase. The scheduled task reads this file each run, so editing it changes future runs without touching the task itself.

Global business rules and voice rules live in `~/.claude/CLAUDE.md`. Repo-specific decisions and current schema state live in this repo's `CLAUDE.md` (the authoritative source). Memory entries in `~/Library/.../memory/MEMORY.md` capture lessons from previous bug fixes. All three are inputs; this playbook turns them into a recurring sweep.

## Run shape

Each run dispatches seven parallel subagents, one per area. Each subagent returns a structured findings list. The orchestrator then:

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
- Help Scout signature is appended automatically. Replies must not include a sign-off. This applies to seeded reply templates as well as ad-hoc messages, including any default body text seeded via migration. (PV-2026W19-001 surfaced templates that violated this rule and reached production.)
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
- View ownership leak: any new view over an RLS-protected table needs `REVOKE FROM anon, public`. (PV-2026W19-002 surfaced 000148 missing this; 000151 retroactively closed it.)
- Schema state lives in seed + migrations together. Never reason about whether a code/column/row exists from seed.sql alone; migrations add changes after the seed and are authoritative.
- Supabase RPC return values are thenable. `void` on `supabase.rpc(...)` silently drops the fetch. Always `.then()` or `await`.
- Postgres UPDATE-FROM scoping: target table can't be referenced in a JOIN's ON clause inside FROM. Single-table FROM with a pre-joined CTE, or cross-join with predicate in WHERE.
- Placeholder variants can be `is_active=true` with zero `price_tiers` rows as a forward-compat hook. New surfaces must decide how to handle the empty case.
- Letterpress paper stock is Colorplan (GF Smith). Customer-facing copy should say "Colorplan paper" not generic descriptors.
- When proposing a migration that updates existing rows, query live DB state first (via service-role key from `.env` if available) to confirm the WHERE clause matches at least one row. If the strict-equality pattern matches zero live rows, write a loose pattern (LIKE / regex_replace) instead. Migration 000149 (PV-2026W19-001) shipped with strict equality and matched zero live rows because the bodies had drifted, so loose follow-up 000150 had to ship as a separate PR. Avoid the round-trip: read the live data, write the WHERE clause to match.

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
