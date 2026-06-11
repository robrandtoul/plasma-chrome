-- AI draft pipeline cost levers: record prompt-cache token usage on the
-- ledger so shadow can verify caching is actually hitting (cache_read should
-- be large and growing within burst windows). Schema-qualified for the
-- proofs schema; applied by Rob via the stock-control SQL editor.

alter table proofs.ai_drafts
  add column if not exists usage_cache_write integer,
  add column if not exists usage_cache_read integer;
