# Backtest eval set

This directory holds the evaluation data for the AI draft pipeline
(see `docs/ai-draft-pipeline-spec.md`).

- `fixtures/` — one JSON file per historical Help Scout conversation. **Gitignored:
  contains real customer names, email addresses, and message bodies.** Local only.
- `reports/` — output of `pnpm backtest` runs (HTML + JSON diff reports). Also
  gitignored for the same reason.

## Fixture schema

```jsonc
// fixtures/<conversationId>.json
{
  "conversationId": 3348242439,
  "subject": "Acrylic or Gold Metal Cards",
  "createdAt": "2026-06-08T10:56:35Z",
  "status": "pending",
  "tags": [],
  "customerFirstName": "Mia",
  "customerEmail": "…",            // PII — why this directory is gitignored
  "slice": "recent-a",             // which pull window it came from
  "heuristicCategory": "quote_request", // pull-time guess; advisory only
  "thread": [
    { "role": "customer", "createdAt": "…", "author": "Mia",   "body": "<html or text>" },
    { "role": "staff",    "createdAt": "…", "author": "Chris", "body": "…" },
    { "role": "note",     "createdAt": "…", "author": "Rob",   "body": "…" }
  ]
}
```

`thread` is chronological (oldest first), raw bodies as Help Scout returns them
(HTML allowed — the pipeline normalises). Roles: `customer` (inbound), `staff`
(outbound reply), `note` (internal).

## Regenerating / extending the set

The fixtures were pulled via the Help Scout MCP in a Claude Code session
(stratified date slices, inbox 33103, answered customer conversations only —
spam / automated notifications / supplier loops excluded, ≤2 per customer).
Ask Claude to "extend the backtest fixture set" — the pull workflow prompt lives
in the session history and the schema above is the contract. Keep the set frozen
between tune-loop cycles so improvements are attributable.

## Running

```sh
pnpm backtest              # full run (needs ANTHROPIC_API_KEY in .env)
pnpm backtest -- --limit 5 # small slice
pnpm backtest -- --dry-run # no API calls: shows classification inputs + prompts
```
