-- AI draft feedback loop (Phase 3): record the reply the team actually sent
-- against each AI draft, so we can measure how much it was edited. The
-- ai-draft edge function fills these on convo.agent.reply.created, matched to
-- the most recent unmatched drafted row for the conversation. Applied by Rob
-- via the stock-control SQL editor.

alter table proofs.ai_drafts
  add column if not exists sent_body text,
  add column if not exists sent_at timestamptz,
  add column if not exists edit_similarity numeric,
  add column if not exists edit_class text
    constraint ai_drafts_edit_class_check
    check (edit_class is null or edit_class in ('sent_as_is', 'lightly_edited', 'rewritten', 'discarded')),
  add column if not exists feedback_matched_at timestamptz;

-- Partial index for the matcher's "most recent unmatched drafted row" lookup.
create index if not exists ai_drafts_feedback_pending_idx
  on proofs.ai_drafts (helpscout_conversation_id, created_at desc)
  where draft_body is not null and feedback_matched_at is null;
