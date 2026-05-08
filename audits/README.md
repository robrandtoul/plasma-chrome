# Audits

Weekly automated bug audit of the proof viewer codebase.

## How it runs

A scheduled task (`weekly-bug-audit`) fires every Monday at 8:00 local time via Cowork. It reads `PLAYBOOK.md`, dispatches seven parallel subagents (one per area), and writes results to `latest-findings.json`. Safe-listed fixes auto-commit to a `bug-audit/YYYY-MM-DD` branch. Everything else becomes a `[proposed]` commit on the same branch with a draft PR.

The audit always targets `main`. Worktrees under `.claude/worktrees/` are ignored.

## Files

- `PLAYBOOK.md` — the audit ruleset. Edit this to change what future runs look for. Tracked in git.
- `latest-findings.json` — most recent run's findings. Overwritten each run. Gitignored.
- `history/` — archived prior runs. Gitignored.

## Reviewing findings

Open the Cowork dashboard artifact (`bug-audit-dashboard`) for a triage view. Or read `latest-findings.json` directly. Or check the open draft PR if one exists.

For each proposed finding: review, tweak the commit if needed, mark merge-ready or dismiss. Recurring false positives should get a corresponding tightening of the rule in `PLAYBOOK.md`.

## Running ad-hoc

The scheduled task can be triggered manually from the Cowork sidebar. Find `weekly-bug-audit` in the Scheduled section and click Run now.
