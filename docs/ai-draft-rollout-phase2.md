# AI draft pipeline — Phase 2 rollout

Companion to `docs/ai-draft-pipeline-spec.md`. Phase 1 (backtest + three tune
cycles) passed Rob's quality gate 2026-06-11. This doc is the live-integration
runbook: what ships, in what order, and exactly what Rob does at each step.
Same conventions as `docs/followup-automation-rollout.md` — Claude never
applies anything to prod; Rob pastes/approves each step.

## What Phase 2 ships

- **Migration `000216_ai_draft_pipeline_phase2.sql`** — `proofs.ai_drafts`
  ledger (service-role writes, designer reads) + `proofs.settings.ai_drafts_mode`
  (`off` default / `shadow` / `live`).
- **`ai-draft` edge function** — the drafting worker. Service-role gated
  (send-nudges auth pattern). Fetches the conversation from Help Scout, runs
  the exact pipeline the backtest proved (shared `_shared/aiDrafts/` core),
  claim-first dedupe keyed on (conversation, newest customer thread).
  - `shadow`: results land only in the ledger.
  - `live`: also creates the Help Scout **draft reply** (`draft: true` —
    never emailed until a human sends), the internal **note** with the
    working, and the `ai-draft` **tag**. Action-note abstentions (e.g.
    ready-to-invoice) create the note only.
- **`helpscout-webhook` extension** — additionally handles `convo.created`
  and `convo.moved`, and triggers drafting on those plus
  `convo.customer.reply.created` (fire-and-forget; the worker gates on
  mailbox 33103 + mode + dedupe). ⚠️ Reply-timestamp stamping now runs ONLY
  for reply events, so a created/moved conversation can never fake a staff
  touch and quiet the needs-attention rules.

## Rob's checklist (in order)

1. **Apply the migration.** Stock-control dashboard → SQL editor → paste
   `supabase/migrations/000216_ai_draft_pipeline_phase2.sql` → run.
2. **Set the secret** (Terminal):

   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...your-key... --project-ref bjvinrzbdrwebylkmbwy

3. **Deploy the two functions** (Homebrew CLI, from the repo root):

   supabase functions deploy ai-draft --project-ref bjvinrzbdrwebylkmbwy

   supabase functions deploy helpscout-webhook --project-ref bjvinrzbdrwebylkmbwy

4. **Tick the webhook events.** Help Scout → Manage → Apps → Webhooks → the
   existing proofs webhook → tick **Conversation Created** and
   **Conversation Moved** (Customer Reply Created should already be ticked
   from the reply-activity work). Save.
5. **Flip to shadow.** SQL editor:

   update proofs.settings set ai_drafts_mode = 'shadow';

6. **Watch for a few days.** Every genuine Customer Support arrival should
   produce a ledger row. Check with:

   select created_at, state, category, helpscout_conversation_id, abstain_or_block_reason from proofs.ai_drafts order by created_at desc limit 20;

   Healthy signs: rows appear within ~1 minute of real emails; spam produces
   `skipped`; categories look right; no `failed` rows. (`failed` rows carry
   the error message — show Claude.)
7. **The attribution test (before live).** Send a test email from a personal
   address to Customer Support; flip mode to `live` briefly (or ask Claude to
   trigger one draft manually); open the conversation in Help Scout and
   confirm: the draft sits in the reply editor, the note shows the working,
   the tag is applied — then **Chris sends the draft** and we verify the
   email the test address receives is attributed to Chris, not the house
   account. If attribution is wrong, mode goes back to `shadow` and the
   fallback design (draft lives in the note) kicks in.
8. **Go live.** `update proofs.settings set ai_drafts_mode = 'live';`
   Kill switch is the same statement with `'off'` — takes effect on the next
   webhook delivery, nothing to deploy.

## Deferred to Phase 3 (build after live is stable)

- **Feedback loop (build first — it unlocks the headline metric).** Two
  layers, deliberately separate:
  - *Layer 1 — mechanical (the metric).* Capture the reply the team actually
    sent (`convo.agent.reply.created` already arrives at the webhook), store
    it against the draft, and compute an edit-distance / "sent as-is | lightly
    edited | rewritten | discarded" classification per row. Cheap,
    deterministic, no intelligence. Gives the acceptance number per category.
  - *Layer 2 — semantic (the learning), on top of layer 1.* Periodically
    (e.g. weekly), take the rows a human edited meaningfully, batch the
    (draft → sent) pairs, and run an LLM pass that clusters them by what the
    edits are *doing* — not by shared text — and proposes specific house-rule
    or exemplar tweaks. This is the same kind of intelligence that writes the
    drafts, turned around to read the corrections, so it catches a pattern
    even when no two edits share a word ("the team keeps deleting the VAT line
    on EUR quotes", "they keep softening hard refusals", "they keep trimming
    the opening"). Pattern detection is fuzzy/semantic by design — exact-text
    matching would detect almost nothing, since humans never edit identically.
  - *Guard-rails on the learning (why a human stays in the seat).* Propose a
    change only on **recurrence** across several independent conversations,
    never a one-off (a one-off is usually a typo fix or a customer-specific
    touch). Not every edit is a learnable rule — some are customer-specific,
    some are the human being wrong, some are pure taste that varies by who
    replied — so the machine cannot reliably tell "general policy" from
    "one-off", and **every proposed rule lands in the admin Drafts panel for
    Rob to approve or reject before it changes any future draft.** Surface
    reviewer disagreement (Chris edits one way, Rob another) rather than
    averaging it into a mushy rule. Net: detection is automated and clever;
    the decision is always human and the output is always a concrete,
    auditable rule in plain English. Glass box, not black box. This is the
    industrialised version of the manual tune cycles (1–3) that built the
    current briefing — same loop, the measurement half automated.
  - Deliberately NOT in scope: automated fine-tuning of model weights, or
    auto-injecting recent sent replies as examples without review (absorbs
    bad/rushed replies as gospel, not auditable, drifts, poisoning risk, and
    unnecessary at this volume). A possible Phase 4 middle path —
    *dynamic exemplar retrieval* (fetch the most similar past blessed
    email→reply pair per incoming email) — earns consideration only once the
    human-curated loop has proven itself, and only from a blessed-replies pool.
- **Analytics (the evidence base for every graduation decision).** The ledger
  is already collecting the raw material during shadow — category, confidence,
  outcome, token + cache cost, and both timestamps — so these can chart over
  history from day one. Metrics that change a decision, in priority order:
  - *Acceptance rate per category* (needs the feedback loop): sent-unedited /
    lightly-edited / rewritten / discarded. The headline number; drives which
    categories are kept, extended, or (much later, on sustained evidence)
    considered for auto-send.
  - *Coverage / silence audit*: of genuine customer emails, the drafted vs
    abstained vs skipped split, and where it stays silent — surfaces a
    category it should help with but isn't.
  - *Cost trend*: per-email cost, cache-hit rate, monthly spend (the
    `usage_*` / `usage_cache_*` columns feed this directly).
  - *Latency*: arrival → draft-ready (`created_at` → `completed_at`) — proves
    the "draft waiting when you open the inbox" promise.
  - *Health*: failure rate and error patterns, so a quietly-broken batch is
    visible rather than mistaken for a quiet day.
  Resist vanity metrics — the test for inclusion is "does this number change
  what we do next?".
- **Admin Drafts panel:** surfaces the analytics above; mode switch +
  per-category switches in the UI; kill switch; house-rules/exemplars editors
  (briefing graduates from repo files to DB tables).
- Grounding enhancements from the review sessions: customer-context pack
  (past orders/materials/proofs + un-actioned-proof flags from the proofs
  schema), stock-control order status + DPD tracking, HS attachment metadata
  to the classifier, artwork image vision.
- Weekly exemplar-promotion proposals; auto-send graduation discussion only
  on sustained evidence (read from the acceptance-rate analytics).

## Operational notes

- Cost: ~8–10¢ per drafted email at current volume (~£15–20/month). The
  `off`/`shadow`/`live` switch needs no redeploys.
- The briefing pack (tone guide, house rules, exemplars, approved pages)
  lives in `supabase/functions/_shared/aiDrafts/briefing/` — editing it is a
  code change + `ai-draft` redeploy until the Phase 3 admin panel ships.
- The backtest harness (`pnpm backtest`) remains the regression suite: any
  briefing or model change reruns the 129-conversation eval set first.
- Tests: `pnpm test:ai-drafts` (123 checks) covers guardrails, money parsing,
  URL gating, thread mapping, and the form pre-gate.
