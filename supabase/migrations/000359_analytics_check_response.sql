-- Admin → Analytics: does a flagged check change what the designer does next?
--
-- The reporting question the usage tab couldn't answer. The preview gate's two
-- buttons have been audited since 10 July (`version.preview_confirmed` /
-- `version.preview_edit_return`), but the audit row never said what the check
-- was showing at the time — and a re-run REPLACES the stored report, so a
-- designer who saw a flag, went back, fixed it and re-ran leaves a clear report
-- behind and no trace of the flag that sent them back. Reconstructing it from
-- timestamps is guesswork.
--
-- Both gate buttons now stamp the check's on-screen state into the audit
-- metadata (`check_ran` / `check_verdict` / `check_flags` / `check_defects`,
-- artworkCheckAuditFields in ArtworkCheckReportView.tsx), and the order review
-- page's Cancel does the same as `order.review_exited`. This adds a
-- `gate_response` key reading those rows.
--
-- What it deliberately does NOT do: quote an order-side RATE. Only the EXIT is
-- stamped there; placements are audited server-side by place-order as
-- `order.placed` with no check metadata, and that function handles money and
-- the production hand-off, so it isn't worth touching for reporting. Order
-- exits are therefore reported as counts, never as a denominator.
--
-- Rows predating this migration have no `check_ran` key and are excluded by
-- the `? 'check_ran'` guard rather than counted as "no check" — which would
-- silently pad the baseline with every gate click since July.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

create or replace function proofs.analytics_check_response(p_days int default 30)
  returns json
  language sql
  stable
  set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with win as (
    select now() - make_interval(days => greatest(coalesce(p_days, 30), 1)) as since
  ),
  -- Preview-gate decisions carrying the new stamp. One row per click.
  gate as (
    select
      a.action,
      case
        when coalesce((a.metadata->>'check_ran')::boolean, false) is not true then 'no_check'
        when a.metadata->>'check_verdict' in ('flagged', 'defect') then 'flagged'
        when a.metadata->>'check_verdict' = 'clear' then 'clear'
        else 'other'
      end as band
    from proofs.audit_log a, win
    where a.created_at >= win.since
      and a.action in ('version.preview_confirmed', 'version.preview_edit_return')
      and a.metadata ? 'check_ran'
  ),
  bands as (
    select band,
      count(*) as decisions,
      count(*) filter (where action = 'version.preview_edit_return') as edited
    from gate group by band
  ),
  exits as (
    select
      count(*) as total,
      count(*) filter (where a.metadata->>'check_verdict' in ('flagged', 'defect')) as after_findings
    from proofs.audit_log a, win
    where a.created_at >= win.since
      and a.action = 'order.review_exited'
  )
  select json_build_object(
    'days', greatest(coalesce(p_days, 30), 1),
    -- Proof side: the comparison. 'no_check' is the honest baseline — the same
    -- gate, the same designers, no check consulted.
    'flagged', (select json_build_object('decisions', decisions, 'edited', edited) from bands where band = 'flagged'),
    'clear', (select json_build_object('decisions', decisions, 'edited', edited) from bands where band = 'clear'),
    'no_check', (select json_build_object('decisions', decisions, 'edited', edited) from bands where band = 'no_check'),
    -- Order side: counts only, for the reason above. Also a lower bound — a
    -- reviewer leaving via the browser back button isn't counted.
    'order_exits', (select json_build_object('total', total, 'after_findings', after_findings) from exits),
    -- So the page can say "nothing recorded yet" rather than "0%" while the
    -- stamped rows accumulate.
    'stamped_decisions', (select coalesce(sum(decisions), 0) from bands)
  );
$$;

comment on function proofs.analytics_check_response(int) is
  'Admin → Analytics: preview-gate outcome split by what the artwork check was showing at click time (flagged vs clear vs no check consulted), plus order-review exit counts. Reads the check metadata stamped on the audit rows; pre-stamp rows are excluded.';

revoke all on function proofs.analytics_check_response(int) from public, anon;
grant execute on function proofs.analytics_check_response(int) to authenticated;
