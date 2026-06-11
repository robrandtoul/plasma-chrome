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

- Feedback loop: capture sent replies (`convo.agent.reply.created` already
  arrives), diff against `draft_body`, edit-distance per category.
- Admin Drafts panel: ledger stats, mode switch + per-category switches in
  the UI, house-rules/exemplars editors (briefing graduates from repo files
  to DB tables).
- Grounding enhancements from the review sessions: customer-context pack
  (past orders/materials/proofs + un-actioned-proof flags from the proofs
  schema), stock-control order status + DPD tracking, HS attachment metadata
  to the classifier, artwork image vision.
- Weekly exemplar-promotion proposals; auto-send graduation discussion only
  on sustained evidence.

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
