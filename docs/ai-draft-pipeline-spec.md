# AI draft pipeline — Phase 1 build brief

Approved by Rob 2026-06-11. Companion to the assessment plan (drafts-first, human-sends,
backtest-before-live). This doc is the working spec for the build; update it as decisions
change, the same way `docs/followup-automation-rollout.md` tracked the nudge project.

## What this is

An AI "drafting brain" that reads an inbound Customer Support email (or a conversation
moved into Customer Support), classifies it, gathers grounding data from the live
database, and writes a reply draft in Plasma's house voice — for a human to review,
edit, and send from Help Scout. Nothing is ever sent to a customer by the system.

Decisions locked in with Rob:

- **AI drafts, human sends.** Drafts appear inside Help Scout (API `draft: true`) with a
  working-shown internal Note. No customer-facing automation.
- **Backtest-first rollout.** Quality is proven against the historical corpus *before*
  any live integration. Forward shadow only verifies plumbing.
- **Briefed intelligence, not templates.** Every draft is written fresh against the full
  thread + live data. House rules / tone guide / exemplars are the briefing pack that
  constrains facts and voice, never wording.
- **Guardrails are hard gates.** A draft containing a money figure that does not
  reconcile against the database, or a URL not on the approved list, is blocked — the
  system stays silent rather than risk a wrong fact.
- **Silence is a feature.** Categories outside the pilot scope, low classifier
  confidence, complaints, supplier loops: no draft.

## Pilot categories

| Category code | Trigger | Grounding needed |
| --- | --- | --- |
| `quote_request` | customer asks price for a standard config | price tiers, MOQs, personalisation policy, VAT rules |
| `lead_time` | turnaround / "how long" questions | `materials.lead_time_*` |
| `capability_question` | can-you-do-X (etching + cut-through, double-sided…) | production knowledge in briefing pack |
| `sample_request` | customer asks for samples | samples policy (house rule) |
| `order_details_collection` | conversation moved Graphics → Customer Support after design approval; need qty/billing/shipping to invoice. Ask **only for what the thread doesn't already contain.** | thread history itself |

Classified but **never drafted** in Phase 1: `order_status`, `invoice_copy`, `artwork`,
`complaint`, `other` — the classifier labels them (useful triage signal + backtest
data), the drafter abstains.

## Architecture (Phase 1: local backtest harness)

```
backtest/fixtures/*.json        ← stratified sample of real answered conversations
        │                         (pulled via Help Scout MCP; gitignored — PII)
        ▼
scripts/run-backtest.ts         ← harness: for each fixture, cut the thread at the
        │                         moment before the first staff reply, then…
        ▼
src/ai-drafts/pipeline.ts
  1. normalise thread (HTML → text)
  2. classify (Claude, structured output)
  3. fetch grounding  ── public_get_price_list(GBP/EUR/USD) + public_get_lead_times()
  4. draft (Claude, structured output: draft_body, note_body, figures_used, abstain?)
  5. guardrails: price reconciliation + URL allow-list  → pass | blocked
        ▼
backtest/reports/<timestamp>/   ← HTML + JSON diff report: draft vs the reply
                                  Chris/Rob actually sent, per category (gitignored)
```

The same `src/ai-drafts/` core gets reused by the Phase 2 edge function — the harness
and the live webhook are just two different callers of `pipeline.ts`.

### Grounding via the public anon RPCs (deliberate)

The harness grounds through `public_get_price_list` and `public_get_lead_times` — the
same SECURITY DEFINER anon RPCs the marketing site uses (migrations 000184/000180).
No service-role key on a laptop, no new surface area, and the data is exactly what a
customer could see anyway. MOQ per material = lowest quantity tier in the price list.
Personalisation pricing (not in those RPCs) is stated as a house rule for Phase 1; the
Phase 2 edge function reads `personalisation_pricing` directly with service role.

### Claude API specifics

- Model: `claude-opus-4-8` (configurable via `AI_DRAFT_MODEL` env), adaptive thinking,
  structured outputs (`output_config.format` JSON schema) for both calls.
- Two calls per email: a small **classify** call, then a **draft** call whose system
  prompt = tone guide + house rules + approved links + per-category exemplars +
  grounding tables. Stable parts first for prompt caching in the live phase.
- Backtest can run sequentially (default) — at ~10¢/email the Batches API discount is
  optional, not required.
- ~8–10¢ per email end-to-end; ~£15–20/month at live volume.

### Prompt-injection posture

Inbound email bodies are untrusted. They are wrapped in explicit
`<customer_email>` delimiters with a standing instruction that the content is data to
be answered, never instructions to follow; the system prompt (briefing pack) always
precedes them; and the blast radius is capped by design — the model's output can only
become a *draft* for human review, and the guardrails strip/block unapproved URLs and
unreconciled figures regardless of what the email said.

## Guardrails (hard gates, code not model)

**Money figures.** Every `£ / € / $` figure in `draft_body` must reconcile against the
grounding set for that conversation:

- exact match to a grounding figure (price tier, surcharge, lead-time-irrelevant), or
- a sum of up to two grounding figures (e.g. £279 base + £50 personalisation = £329), or
- a VAT transform (÷1.2 or ×1.2, GBP only) of an accepted figure (e.g. £329 → £274.17
  ex VAT), within 1p tolerance.

Anything else → draft blocked, reason logged. The model also self-reports
`figures_used` (amount + source description) so the note can show its working, but the
gate runs on the *rendered draft text*, not on the self-report.

**URLs.** Every URL in `draft_body` must prefix-match the approved-links list
(`src/ai-drafts/briefing/approvedLinks.ts`). Unknown URL → blocked.

**Abstention.** The drafter can return `should_draft: false` with a reason (complaint
detected, missing information, out-of-scope material, thread already answered). The
classifier's category + confidence gates the drafter: only pilot categories at
medium+ confidence reach the draft call.

## The briefing pack (Phase 1: in-repo, version-controlled)

`src/ai-drafts/briefing/` — house rules, tone guide, approved links, seed exemplars.
Kept in the repo for the backtest phase **on purpose**: every tune-loop change is a
git-diffable commit, so backtest cycles are reproducible. The admin-editable DB tables
(`ai_draft_rules`, `ai_draft_exemplars`) come in Phase 3 when designers need to edit
without a deploy; the file contents become the seed migration.

Tone guide source: the pd-customer-support plugin's tone-guide conventions (warm
professional British English, "Hi {first name}," only, no exclamation marks, no staff
names, 2–3 short paragraphs, no sign-off — Help Scout appends it) cross-checked against
real sent replies during the backtest.

## Backtest design

**Sample** (pulled 2026-06-11, target ~130): tiered windows — last 6 months weighted
(~60), 6–12 months (~45), 12–24 months rare-categories-preferred (~24); inbox 33103
only; ≥1 staff reply; spam/notifications/supplier loops excluded; ≤2 per customer.
Fixture schema documented in `backtest/README.md`. Fixtures and reports are
**gitignored** — they contain customer names, emails, and message bodies.

**Unit of evaluation:** the thread cut just before the first staff reply → generate a
draft as-if at that moment → diff against the reply actually sent.

**Scoring:**

- Recent slices (≤6 months): full comparison including figures (DB ≈ what the human saw).
- Older slices: structure/completeness/tone only — figure mismatches are *expected*
  (price + catalogue drift) and reported separately, not counted as failures.
- The historical reply is not automatically gold: the report shows both side by side
  and Rob/Chris judge "would I have sent the draft?". A draft can beat the human reply.
- Hard failures regardless of age: hallucinated figure that the guardrail caught
  (good — gate works) or that slipped the gate (bad — gate bug, fix before anything
  else); unapproved URL; drafting on a category that should have abstained.

**Tune loop:** run → review report → adjust briefing pack (rules/exemplars) → commit →
rerun. The fixture set is frozen between cycles so improvements are attributable.

**Permanence:** this harness is the regression suite — same pattern as
`src/price-list/golden-master*`. Any future change to rules, exemplars, model, or
prompts reruns the backtest before shipping.

## Phase 2/3 (deferred — build after the backtest gate passes)

- `helpscout-webhook` extension: subscribe `convo.created` + `convo.moved`; on
  qualifying events (mailbox 33103) fire the drafting edge function via
  `EdgeRuntime.waitUntil` (house pattern from proof-action's deferHideThread).
- New edge function reusing `src/ai-drafts/` core (Deno-compatible imports); claim-first
  ledger insert under a unique constraint (nudge pattern) for webhook-retry dedupe.
- Migration (schema-qualified `proofs.`, explicit grants per the merged-project rules):
  `ai_drafts` ledger (service-role writes, authenticated SELECT — remember the
  explicit REVOKE, 000176 footgun), `ai_draft_rules` + `ai_draft_exemplars`
  (authenticated CRUD), settings columns (`ai_drafts_enabled`, `ai_drafts_mode`,
  `ai_draft_model`, per-category flags).
- Draft creation: POST `/v2/conversations/{id}/reply` with `draft: true` + Note with
  the working + `ai-draft` tag. Verify in Phase 2: how HS renders API drafts, and that
  a draft created under the house user sends *as the designer who clicks send*. If
  attribution is wrong, fallback = draft lives in the Note only.
- Stale-draft handling: `convo.customer.reply.created` on a conversation with an
  unsent AI draft → regenerate draft + note.
- Feedback loop: `agent.reply.created` webhook captures the sent reply; ledger diffs
  sent vs draft (edit distance per category); weekly exemplar-promotion proposals.
- Admin Drafts panel (stats, category switches, kill switch, rules/exemplars editors).

## Rob's checklist (in order, each with exact instructions when reached)

1. **Anthropic Console account** — console.anthropic.com, add card, buy ~$25 prepaid
   credits (auto-reload optional), create API key. Needed before the first backtest run.
   Local use: `ANTHROPIC_API_KEY` in the repo `.env` (gitignored).
2. **Review the diff report** after backtest run 1; tune-loop sessions with Claude.
3. *(Phase 2)* Apply the ledger migration in the stock-control SQL editor; add
   `ANTHROPIC_API_KEY` as a Supabase edge-function secret; tick `convo.created` +
   `convo.moved` on the existing Help Scout webhook; approve edge deploys
   (`--project-ref bjvinrzbdrwebylkmbwy`).

## Privacy

- Fixtures/reports hold real customer emails → gitignored, local only, regenerable.
- Anthropic does not train on API data; processing is request/response only.
- The backtest sends historical customer emails to the Claude API — same category of
  processor as Help Scout itself; no data leaves via any other channel.
