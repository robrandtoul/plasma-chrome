-- 000229: admin-editable triage model for the AI-draft pipeline.
--
-- Triage (the classify call) runs on EVERY inbound email — including spam and
-- notifications — so it is the pipeline's main cost lever. This column lets an
-- admin point JUST the triage step at a cheaper model from the AI-drafts admin
-- page, without touching the draft model (which stays on the default, or the
-- AI_DRAFT_MODEL secret). NULL / '' = use the default model for triage too.
--
-- The ai-draft edge function reads this alongside ai_drafts_mode and threads it
-- into the classify call only. Effort and adaptive-thinking stay gated by the
-- resolved model, so a cheaper override (e.g. Haiku) simply drops those params.
-- Inherits the settings table grants (authenticated CRUD, service_role); no
-- view or anon exposure.

alter table proofs.settings
  add column if not exists ai_drafts_triage_model text;
