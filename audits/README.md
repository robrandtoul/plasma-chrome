# Audits

Two complementary audit shapes for the proof viewer:

- **Weekly automated bug audit** (`PLAYBOOK.md`): scheduled, code-focused, greps for rule violations. Runs Monday morning, leaves a dirty working tree of proposed fixes for shipping via a separate Code prompt.
- **Manual test matrix** (`TEST_MATRIX_PLAYBOOK.md`): on-demand, flow-focused, exercises actual customer, designer, and admin paths in the live database and UI. Output lands in `test-runs/`.

The bug audit catches things that look wrong in code. The test matrix catches things that look wrong in use. Run both.

## How the bug audit runs

A scheduled task (`weekly-bug-audit`) fires every Monday at 8:00 local time via Cowork. It reads `PLAYBOOK.md`, dispatches seven parallel subagents (one per area), and writes results to `latest-findings.json`. Safe-listed fixes auto-commit to a `bug-audit/YYYY-MM-DD` branch. Everything else becomes a `[proposed]` commit on the same branch with a draft PR.

The audit always targets `main`. Worktrees under `.claude/worktrees/` are ignored.

## How the test matrix runs

On-demand. Branch fresh from main, pick a slice (representative or full sweep), walk each row, capture findings to `test-runs/YYYY-MM-DD.md`. Each P1 or P2 finding becomes its own PR. See `TEST_MATRIX_PLAYBOOK.md` for fixtures, coverage dimensions, and triage patterns.

## Files

- `PLAYBOOK.md`: the bug audit ruleset. Edit to change what future runs look for. Tracked in git.
- `TEST_MATRIX_PLAYBOOK.md`: manual end-to-end test pass playbook (matrix data plus procedure). Tracked in git.
- `test-runs/`: output reports from manual test matrix passes. Tracked in git.
- `scripts/`: reusable scripts for test matrix passes (e.g. `anon-surface-audit.ts` for anon enumeration regression checks). Tracked in git.
- `latest-findings.json`: most recent bug audit run's findings. Overwritten each run. Gitignored.
- `history/`: archived prior bug audit runs. Gitignored.

## Reviewing findings

Open the Cowork dashboard artifact (`bug-audit-dashboard`) for a triage view. Or read `latest-findings.json` directly. Or check the open draft PR if one exists.

For each proposed finding: review, tweak the commit if needed, mark merge-ready or dismiss. Recurring false positives should get a corresponding tightening of the rule in `PLAYBOOK.md`.

## Running ad-hoc

The scheduled task can be triggered manually from the Cowork sidebar. Find `weekly-bug-audit` in the Scheduled section and click Run now.
