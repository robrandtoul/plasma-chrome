-- 000230: per-call cost split on the AI-draft ledger.
--
-- Until now ai_drafts stored ONE combined usage_* total for both the triage
-- (classify) call and the draft call, and the panel priced it all at the draft
-- model's rate. With the triage model now admin-editable (000229), that makes a
-- cheaper triage model invisible on the cost panel. These columns record the
-- triage call's usage on its own, plus the model it actually ran on, so the
-- panel can price triage at its own rate and the saving shows.
--
-- The existing usage_* columns stay the COMBINED total; draft usage is derived
-- as (combined - triage) in the panel. All nullable: old rows (triage = draft
-- model = the default) read as zero triage tokens, so combined is priced at the
-- draft-model rate — exactly the old, correct behaviour. triage_model is the
-- model triage ran on for THAT row (NULL = same as the draft model `model`),
-- captured per-row because the global setting changes over time.
--
-- Inherits the ai_drafts grants (authenticated SELECT, service_role); not on any
-- public_* view, no anon exposure.

alter table proofs.ai_drafts
  add column if not exists usage_triage_input int,
  add column if not exists usage_triage_output int,
  add column if not exists usage_triage_cache_write int,
  add column if not exists usage_triage_cache_read int,
  add column if not exists triage_model text;
