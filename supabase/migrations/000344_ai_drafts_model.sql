-- 000344: admin-editable model for the AI-draft pipeline's DRAFT step.
--
-- 000229 made the TRIAGE model admin-editable (the cost lever, since triage
-- runs on every inbound). The draft step stayed pinned to the compiled default
-- (or the AI_DRAFT_MODEL secret), so trying a newer model for drafting meant a
-- secret change + redeploy. This column is the UI-settable equivalent, so the
-- team can A/B a model from Admin → AI drafts with no redeploy.
--
-- NULL / '' = fall back to the AI_DRAFT_MODEL secret, then the compiled
-- default in _shared/aiDrafts/anthropic.ts. Deliberately left NULL on apply so
-- behaviour is unchanged until someone picks a model.
--
-- Resolution note for the ai-draft function: an unset TRIAGE model falls back
-- to the RESOLVED draft model (not the compiled default), so the triage
-- dropdown's "Default (same as draft model)" option stays truthful once a
-- draft model is set here.
--
-- Effort and adaptive thinking stay gated by the resolved model id, so a
-- cheaper override (e.g. Haiku, which 400s on effort) simply drops those
-- params. Inherits the settings table grants (authenticated CRUD,
-- service_role); no view or anon exposure.

alter table proofs.settings
  add column if not exists ai_drafts_model text;

comment on column proofs.settings.ai_drafts_model is
  'Claude model id the AI-draft DRAFT step runs on (Admin → AI drafts). NULL = env AI_DRAFT_MODEL, then the compiled default. Takes effect on the next draft, no redeploy.';
