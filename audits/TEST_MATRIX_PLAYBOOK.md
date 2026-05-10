# Test Matrix Playbook

This playbook drives a focused, end-to-end manual sweep of the proof viewer to surface bugs across customer, designer, and admin surfaces. It complements the weekly bug audit (`PLAYBOOK.md`) which is automated and code-focused. Where the bug audit greps for rule violations, the test matrix exercises actual flows in the live database and customer-facing UI.

Global business rules and voice rules live in `~/.claude/CLAUDE.md`. Repo-specific decisions and current schema state live in this repo's `CLAUDE.md`. Memory entries in `~/Library/.../memory/MEMORY.md` capture lessons from previous fixes. This playbook turns those into a reusable test pass.

> **Schema reminder (post-000098):** CNC cutting and gilded letterpress are distinct materials (`carbon_fibre_cnc`, `paper_letterpress_gilded`), not per-material option dimensions. Rows below reflect the post-supersession shape. When the schema shifts again, update the rows here so the playbook starts from live state, not historical state.

## When to run

A test pass is appropriate when:

- A material set of changes has shipped (e.g. several feature commits over a sprint) and you want a confidence check before announcing.
- A new designer is about to start using the app and you want a known-good baseline.
- An issue has been reported in one area and you want to check whether adjacent areas are also affected.
- You're between feature blocks and want to find what's broken before deciding what to build next.

A pass takes roughly 4–6 hours for a representative slice (6–10 rows), or a full day for a comprehensive sweep (all 62 rows). A representative slice has historically been productive enough to justify the time on its own. The 2026-05-09 first pass surfaced one P1 plus several smaller bugs in just six rows.

## Run shape

1. **Branch fresh from updated main.** Worktree-based per the project pattern: `git worktree add .claude/worktrees/<name> -b qa/<topic> main`. Branch name format: `qa/<scope>` (e.g. `qa/first-pass-test`, `qa/translucent-plastic-ink-validation`).
2. **Pick a slice.** Either pick a representative slice covering different materials, currencies, and recipient models, or commit to a full sweep. Document the chosen rows up front.
3. **Set up fixtures** per the rules in `Fixtures and isolation` below. All test proofs link to the same Help Scout conversation and contact, prefixed `[QA]`.
4. **Walk each row.** Set up the proof, exercise the action, capture findings.
5. **Write findings to a single report** at `audits/test-runs/YYYY-MM-DD.md`. Top: summary table (row, status, headline). Below: section per row with detail.
6. **Triage findings.** Each P1 or P2 finding becomes its own PR via the patterns in `Triaging findings into PRs`. P3 findings can batch.
7. **Stop on completion.** Cleanup test fixtures (or leave them tagged for the next run).

## Fixtures and isolation

All test proofs link to **Help Scout conversation 422593** and the contact **proofviewertest@icloud.com** (Rob-controlled). This means:

- Confirmation replies from the proof-action edge function land in Rob's mailbox, not a customer's.
- The email-driven match flow on `/proofs/new` will surface the same HS conversation each time. Once there are several test proofs against this contact the multi-match picker fires, which is itself a path worth covering.
- Test contact and company sit under a clearly-named umbrella: company "QA Lab", contact "Proof Viewer Test".

**Tag every test proof name with `[QA]` prefix** so they can be filtered out of the dashboard or bulk-abandoned. The convention is established and shouldn't drift between runs.

**Do not record real customer email addresses or HS conversation IDs in test fixtures.** All test traffic goes to 422593.

Cleanup at the end of a run: bulk-abandon `[QA]`-prefixed proofs, or leave them parked for the next run. Either is fine; just don't let them age into customer-engagement metrics.

## Coverage dimensions

The matrix sits at the intersection of these dimensions. Not every cell needs a row, but every dimension needs at least one row that exercises it.

- **Material × variant**: each material with its primary variant_type, plus one secondary variant where applicable.
- **Currency**: GBP (VAT inclusive), EUR, USD (one currency per row, but cycle through across the matrix).
- **Pricing display mode**: standard vs custom quote.
- **Recipient model**: single name, split-name (2 names), split-name (3+ names), variant round.
- **Variant round sub-mode**: per-direction-pricing off, per-direction-pricing on.
- **Customer action**: view only, approve, request changes, select variant.
- **Status path**: in_progress → approved, in_progress → abandoned, in_progress → dormant → bumped back, approved → reopened.

## Material rows

Each material gets at least one core row. Add edge rows where the material has known quirks.

| # | Material | Variant | Currency | Mode | Recipients | Notes |
|---|----------|---------|----------|------|-----------|-------|
| 1 | Metal Steel | 800um, Mirror | GBP | Standard | Single | Surcharge bakes into grid; "+from £X" suffix on Mirror tab |
| 2 | Metal Steel | 500um, Brushed | EUR | Standard | Split (2 names) | Tooling surcharge €39 per extra name |
| 3 | Metal Gold | 800um, Mirror | USD | Standard | Single | Confirms USD surcharge schedule matches GBP/EUR |
| 4 | Metal Copper | 800um, Natural | GBP | Custom quote | Single | Custom-quote panel replaces grid; check copy |
| 5 | Metal Gun Metal | 800um, Natural | GBP | Standard | Single | qty 750 row check (000146 reconciled this) |
| 6 | Plastic Translucent | 1-ink | GBP | Standard | Single | Requires_ink_names: 1 ink field, required validation |
| 7 | Plastic Tinted | 2-ink | EUR | Standard | Split (3 names) | 2 ink fields, all required; +€39 × 2 split surcharge |
| 8 | Plastic Satin | 3-ink | USD | Standard | Single | Pricing must mirror Translucent (memory: known parity) |
| 9 | Plastic Full Colour | default | GBP | Standard | Split (2 names) | £15 split surcharge per extra name |
| 10 | Wood Black Walnut | species variant | GBP | Standard | Single | No surcharge → "+from" suffix should be suppressed |
| 11 | Wood Bamboo | species variant | EUR | Standard | Single | Identical pricing to Black Walnut by design |
| 12 | Standard Paper | UV Spot | GBP | Standard | Single | Three-finish-as-variants model; not additive |
| 13 | Standard Paper | Foiling | USD | Standard | Single | |
| 14 | Letterpress (no gild) | 1-ink, core colour | GBP | Standard | Single | Colorplan core+front+back colour render |
| 15 | Letterpress gilded | 2-ink, full edge construction | EUR | Standard | Split (2 names) | Distinct material code, not an add-on |
| 16 | Acrylic | default | GBP | Standard | Single | Split-name surcharge enabled (000146) |
| 17 | Carbon Fibre (`carbon_fibre`) | default | USD | Standard | Single | Single-variant material, no options post-000098 |
| 18 | Carbon Fibre with CNC (`carbon_fibre_cnc`) | default | GBP | Standard | Single | Distinct material (000098 split), single-variant, no options; own price tiers |

## Variant round rows

| # | Setup | Mode | Notes |
|---|-------|------|-------|
| 19 | 2 variants, same material, same currency | Standard | Customer page lock-on-selection; carry-forward on round 2 |
| 20 | 2 variants, per-direction-pricing on (different thicknesses) | Standard | Pricing card, Specification, About-material all hidden |
| 21 | 2 variants, per-direction-pricing on (different materials) | Standard | Mixed material families; confirms 000144 rename behaviour |
| 22 | 3 variants, single direction (front only) | Standard | Variant codes write-once; sort_order respected |

## Customer action rows

For each, start from a fixture in row 1–18 and exercise the action.

| # | Action | Expected | Known seam |
|---|--------|----------|------------|
| 23 | View as customer (no auth) | View event logged in dashboard sidebar (000127) | RLS leak check: anon must not see other proofs (covered by `audits/scripts/anon-surface-audit.ts` post-000162) |
| 24 | Single-recipient approve | Status flips to approved; HS confirmation reply via 000157 template | proof_approval_confirmation template body |
| 25 | Per-recipient approve, partial | Some names approved, status stays in_progress | maybe_finalize_proof_status only fires on full set |
| 26 | Per-recipient approve, full | All slots filled (names + __shared__ if applicable), status flips | 000126 trigger |
| 27 | Request changes | Status stays in_progress; HS confirmation via change_request template | |
| 28 | Variant selection (variant round) | Lock on selection; HS confirmation via variant_selection template | 000157 |
| 29 | Reopen approved proof | Status back to in_progress; carry-forward approvals cleared (000158 RPC) | The bug 000158 fixed: v1 approvals must not persist on v2 |
| 30 | View dormant proof | Activity bumps it back to in_progress (only that direction) | 000018 trigger |
| 31 | View abandoned proof | Abandoned screen renders; no edit path | |
| 32 | Visit invalid proof id | Quiet 404, not jarring | |

## Designer flow rows

| # | Action | Notes |
|---|--------|-------|
| 33 | New proof, manual contact picker | Baseline path |
| 34 | New proof, `?contactId=...` param | Pre-fill, then email-driven match fires |
| 35 | New proof, `?companyId=...` param | Pre-fill, contact still empty |
| 36 | New proof, HS URL paste | URL-paste lookup edge function |
| 37 | New proof, contact with multiple HS convos | Multi-match picker (will fire after a few test proofs against 422593) |
| 38 | New proof, contact with no HS convos | Override-reason panel |
| 39 | New version, same material | Carry-forward of approvals |
| 40 | New version, switch material | Pricing snapshot recomputes; ink-name fields appear/disappear |
| 41 | New version, switch to custom quote mode | Specification still required, pricing card hidden customer-side |
| 42 | Edit version, change images | Per-option-tab image filtering still correct |
| 43 | Edit version, change required fields, save with missing data | submitAttempted highlighting; rose toast; auto-dismiss 5s |
| 44 | Mark as approved (designer button) | Belt-and-braces path; should still work for legacy proofs |
| 45 | Abandon proof | Confirm dialog; abandoned_at set |
| 46 | Reopen approved proof (designer side) | RPC path matches 000158 expectations |

## Dashboard rows

| # | Surface | Notes |
|---|---------|-------|
| 47 | Tile counts | Single round-trip via `dashboard_tile_counts()`; numbers match list view |
| 48 | Needs-attention: request_changes_no_version | Trigger by requesting changes, not creating v2 |
| 49 | Needs-attention: helpscout_follow_up_tag | Manually populate `proofs.helpscout_tags` until HS sync ships |
| 50 | Needs-attention: sent_never_viewed | Create proof, don't view as customer, wait threshold |
| 51 | Needs-attention: viewed_not_actioned | View but don't approve or request changes |
| 52 | Needs-attention: approaching_dormant | Set `last_activity_at` directly via SQL to 25–30 days ago (waiting the 25 days isn't practical) |
| 53 | Needs-attention: stuck_in_progress | Manual age-out via SQL |
| 54 | Pin (mine) | Visible to Rob only, persists across reloads |
| 55 | Pin (team) | Visible to all designers; one team-pin per proof |
| 56 | Show/hide dormant toggle | Filter still works post-redesign |
| 57 | Designer colour pills | Rob blue, Chris teal, Jack purple (000153) |

## Admin rows

| # | Surface | Notes |
|---|---------|-------|
| 58 | Pricing index | `material_price_tier_counts` view returns full counts (no 1000-row truncation, 000148/000151) |
| 59 | Edit material option surcharge | Direct insert + audit row pattern |
| 60 | Reply template editor | Reset to default restores body for all three confirmation codes |
| 61 | Needs-attention rules editor | Threshold change reflects in dashboard on next refetch |
| 62 | Site settings: dormancy threshold | Cron job picks up new value |

## What to record per row

For each scenario, capture:

- **Status**: pass / fail / partial / blocked
- **Observed behaviour**: short prose, plus a screenshot if visual
- **Console errors**: browser console plus Supabase edge function logs
- **Network**: any 4xx / 5xx from the public_* views, RPCs, or edge functions
- **Notes**: anything that worked but felt off (copy, spacing, timing)

## Output format

A single markdown report at `audits/test-runs/YYYY-MM-DD.md`. Re-runs the same day suffix the filename (e.g. `2026-05-10-rls-recon.md`).

Top: summary table.

```
| Row | Status | Headline |
|-----|--------|----------|
| 1   | pass   | Mirror metal + GBP renders correctly |
| 6   | pass   | Translucent 1-ink with required validation |
| 23  | fail   | P1: anon role can enumerate every proof's PII |
```

Below: section per row with the captured detail. Failures get fleshed out, passes get a one-liner.

If a follow-up recon script gets written for a finding (e.g. `audits/scripts/anon-surface-audit.ts` from the 2026-05-09 run), commit it alongside the report so it's reusable as a regression test on future passes.

## Triaging findings into PRs

Each P1 or P2 finding becomes its own PR off updated `main`. Patterns from the 2026-05-09/10 first pass that are worth following:

**Security-sensitive fixes (P1):** stage discipline. Investigate first (no DB or code changes), surface a design proposal with the proposed migration body and refactor list, pause for sign-off, then implement, build, push the migration to live, sanity-test against live, PR. Pause again before push to prod for migration sign-off. Example: PR #42 (anon enumeration leak, migration 000162).

**Schema vs documentation drift:** diagnose before writing SQL. The fix shape depends on whether a migration was never pushed, was pushed but later reverted, or is intentional supersession. Use `pnpm db:diff` and `supabase migration list --linked` plus targeted SELECTs against the live DB. Example: Row 17 carbon fibre Cutting drift turned out to be intentional supersession by 000098, not schema drift, and the fix was doc-only (PR #43).

**Mechanical fixes (copy, state hygiene):** investigate-and-fix in one pass. One commit per bug, build clean, browser sanity where reachable from the form UI. If the actual bug path isn't trivially triggerable from the UI (e.g. partial-success retry), document the testing limitation in the PR body. Examples: PRs #44 (copy fixes), #45/#46 (form insert state hygiene).

**Behaviour changes that need a UX call:** stop and discuss before implementing. Two competing framings are usually worth surfacing. Example: skipping `record_proof_view` for authenticated sessions (PR #47) was a customer-engagement-signal vs any-view-signal call worth a chat before code.

**Worktree-first merge:** remove the feature worktree before `gh pr merge --merge --delete-branch`, then pull main. Silent stdout = both branch deletes ran. See `feedback_gh_pr_merge_worktree.md` memory for the gotcha (any worktree holding the feature branch breaks `git branch -d` and aborts the whole flow including the remote-delete step).

**Build before pushing:** `pnpm build` clean is the lower bar. For migrations, `pnpm db:diff` is read-only and shows what's local-only; `pnpm db:push:confirm` applies. Never raw `db push`.

## Open questions for future runs

- **Single end-to-end pass vs split-by-area:** the 2026-05-09 first pass took a representative slice across areas. A full 62-row sweep hasn't been tried yet. Worth a structured experiment.
- **Dormancy and approaching-dormant rules (rows 30 / 52):** confirmed test path is direct SQL on `last_activity_at`. Document the exact UPDATE statement once it's been run successfully.
- **Admin pricing edits:** confirmed safe against live with `[QA]` tag isolation and audit log entries proving what changed (per the 2026-05-09 run). No separate Supabase project needed.
- **`selectedContact` UX on retry:** parked from PR #46. When a designer creates a new contact inline, fails downstream validation, and retries, the form re-attempts the contact insert and hits 23505. Fix shape needs a UX decision before code.

## Updating the playbook

After a pass, if a new pattern emerged that should be covered next time, add it to the matrix. If a row turned out to be redundant, drop it. New schema changes that affect live shape (like 000098 splitting CNC cutting out as a distinct material) should land as a preamble note plus row updates so future passes start from the live state.

The matrix gets sharper every pass; that's the whole point.
