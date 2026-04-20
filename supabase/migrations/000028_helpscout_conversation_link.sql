-- Migration 000028: structured Help Scout conversation link on proofs
--
-- Adds two nullable columns so the app can auto-link a proof to a specific
-- Help Scout conversation when the customer's email matches. The existing
-- helpscout_thread_url column is kept — for API-linked proofs the app
-- mirrors the conversation URL there too, so the proof detail page's
-- existing display keeps working unchanged.

begin;

alter table proofs
  add column helpscout_conversation_id  text,
  add column helpscout_conversation_url text;

commit;
