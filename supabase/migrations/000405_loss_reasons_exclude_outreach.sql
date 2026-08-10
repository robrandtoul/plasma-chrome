-- 000405: keep outreach declines out of the "Why we lose" panel.
--
-- The re-engagement band's exit routes into the existing decline-feedback
-- mechanism (000279), which writes proofs.proof_feedback — the single source
-- for analytics_loss_reasons(), rendered as "Why we lose" INSIDE the Funnel
-- tab. That is the exact tab 000390 purged of outreach proofs, on the grounds
-- that a project we started by approaching a dormant customer is not a
-- commission we won or lost.
--
-- 000390's own header says analytics_loss_reasons was "deliberately untouched"
-- because "proof_feedback is customer-initiated either way". That sentence stops
-- being true the moment the band can file a decline: a back-book customer
-- saying "not right now" to an email they never asked for is not the same event
-- as a customer who commissioned artwork and then walked away over price, and
-- averaging the two corrupts the panel Rob reads when thinking about pricing.
--
-- So the same exclusion, expressed the same way: skip proofs carrying a
-- reengagement_context. Consistent with 000390 rather than a new idea.
--
-- ⚠ Keyed on reengagement_context, NOT reengagement_prospect_id — that column
-- is FK ON DELETE SET NULL, so deleting a register row would silently readmit
-- its declines to the funnel. Live already carries a proof with a context and a
-- null prospect id.
--
-- Nothing is lost today: there are zero outreach proofs on live and one
-- proof_feedback row in total, which is not one of them (verified read-only
-- before applying; the function's output is unchanged by this migration).
--
-- DEFERRED, deliberately, and worth writing down rather than discovering later:
-- outreach decline reasons are now recorded but not reported anywhere. "Why did
-- the back book say no" is a genuinely useful question and deserves its own
-- panel with its own denominator — not a row grafted onto a funnel that means
-- something else. The raw rows are in proof_feedback whenever that gets built.
--
-- Signature unchanged, so create-or-replace preserves the ACL. Body re-emitted
-- from the LIVE pg_get_functiondef (which matches 000279 with no drift).

create or replace function proofs.analytics_loss_reasons()
returns table(reason_code text, n integer, latest_at timestamp with time zone)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  select f.reason_code, count(*)::int, max(f.created_at)
  from proof_feedback f
  join proofs p on p.id = f.proof_id
  where p.reengagement_context is null
  group by f.reason_code
  order by count(*) desc;
$function$;

-- Grants restated to match live. No-op under create-or-replace; here because
-- the proofs schema has no pg_default_acl for functions and an omitted revoke
-- is how a function becomes callable from the public internet (000356).
revoke execute on function proofs.analytics_loss_reasons() from public, anon;
grant  execute on function proofs.analytics_loss_reasons() to authenticated, service_role;
