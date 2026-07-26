-- 000349: record the customer's own message on the AI-draft ledger.
--
-- Why: proofs.ai_drafts stores what we DRAFTED (draft_body) and what we SENT
-- (sent_body, migration 000219), but nothing of what the customer actually
-- wrote. That gap is invisible until you try to learn from the ledger:
--
--   * an EXEMPLAR is a (customer message, our reply) pair — see
--     proofs.ai_draft_exemplars — so with only half the pair on the ledger, the
--     Phase 3c miner can never propose one automatically. Exemplars are the
--     strongest lever in the briefing and the least used (all 8 unchanged since
--     they were seeded on 13 June), so this column is the thing standing between
--     the miner and its most valuable output.
--   * "why did the drafter get this wrong?" is unanswerable from a ledger row
--     alone today — the reviewer has to open Help Scout to see the question.
--
-- The classifier's `summary` is not a substitute: it is our paraphrase, not the
-- customer's words, and an exemplar built from a paraphrase teaches the model to
-- answer questions nobody asked.
--
-- Privacy: no new class of data. draft_body and sent_body already carry customer
-- names, addresses and quoted prices; this is the same conversation, same
-- retention, same authenticated-only read path. The worker truncates before
-- writing so one pasted brochure cannot bloat the table.
--
-- ⚠ MIGRATION FIRST, THEN THE ai-draft DEPLOY. This one is the sharpest in the
-- set: the redeployed worker names customer_message in its CLAIM INSERT, which
-- runs before any drafting. An unknown column there is not a 23505 duplicate,
-- so it falls through to "claim failed" and returns 500 — meaning no draft is
-- produced at all, for every enquiry, until the column exists. AI drafting
-- stops dead rather than degrading.
--
-- Additive and nullable with no backfill: every existing row is honestly
-- "customer message not captured", and anything reading this column must treat
-- NULL as unknown rather than empty.

alter table proofs.ai_drafts
  add column if not exists customer_message text;

comment on column proofs.ai_drafts.customer_message is
  'The last customer message in the thread at draft time, plain text, truncated by the worker. NULL for rows written before migration 000349. Pairs with draft_body/sent_body so an exemplar can be proposed from a ledger row alone.';

-- Grants: ai_drafts already exists with its matrix in place (authenticated
-- SELECT, service_role full). A new column inherits the table's grants, so
-- there is deliberately nothing to re-state here — unlike a view, which loses
-- its grants on drop/recreate (see the 000168/000174 footgun in CLAUDE.md).
