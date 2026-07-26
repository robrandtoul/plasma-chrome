-- 000355: count acceptance per briefing version IN THE DATABASE, because the
-- panel was counting a truncated sample and calling it a verdict.
--
-- ── What went wrong ──────────────────────────────────────────────────────────
-- The "Acceptance by briefing version" panel (migration 000351) worked out its
-- numbers in the browser, from the same 30-day row fetch that feeds the two
-- trend charts. That fetch asks PostgREST for rows and PostgREST answers with
-- at most 1000 of them. Measured read-only against live on 2026-07-26:
--
--   rows in the 30-day window ....... 1753
--   rows the browser actually got ... 1000
--   rows silently dropped ...........  753
--   scored replies in the window ....  325
--   scored replies dropped ..........  128  (39% of the evidence)
--
-- Truncation is strictly asymmetric — the fetch is newest-first, so it only
-- ever eats the OLDER side. That is the dangerous shape, because it does not
-- look like missing data:
--
--   · a version's date range reads as its real lifetime when it is actually
--     the row-cap boundary,
--   · a version that started before the boundary shows only its recent tail,
--   · so "Clearly worse than v12" could be produced by the row cap alone, and
--   · the confidence band drawn beside it tells the reader the only
--     uncertainty here is sampling noise, which makes the corruption harder
--     to spot rather than easier.
--
-- A count that can be wrong by 39% must not be computed from a page of rows.
-- It is an aggregate, so it belongs in SQL, where "all the rows" is free and
-- there is no cap to forget about.
--
-- ── The acceptance definition, and the one subtlety in it ────────────────────
-- A draft is SCORED once the team's reply goes out and the feedback matcher
-- compares the two (edit_class). Accepted = sent as-is or lightly edited.
--
-- But migration 000348 exists precisely because the matched reply is often not
-- an edit of the draft at all — it is the proof delivery, the order link, an
-- automated chase. 39% of 'discarded' rows were measured to be that. Those get
-- excluded here (feedback_match_quality = 'unrelated'), so a busy
-- proof-delivery week can no longer drag a briefing's score down and get a
-- good rule reverted.
--
-- ⚠ The filter is `is distinct from 'unrelated'`, NOT `= 'edit'`. NULL means
-- "never assessed" — every row written before 000348 landed — and in SQL
-- NULL = 'edit' is NULL, so an `= 'edit'` test would silently throw away the
-- whole back catalogue and leave the panel scoring a handful of recent rows.
-- NULL must count as includable. Same trap as the one 000348's own header
-- warns about, from the other direction.
--
-- `unrelated` is returned as its own count rather than just being filtered
-- away, so the panel can SAY how many replies it set aside. A silent exclusion
-- is how you end up mistrusting a number you cannot reconcile.
--
-- ── What the version does and does not cover ─────────────────────────────────
-- Worth knowing before reading any verdict off this: the counter only moves
-- for house rules and example replies. The tone guide, the approved-link list,
-- the safety guardrails, the prompt wording and the grounding data all live in
-- CODE and change on deploy without bumping it. So a difference between two
-- versions says the rule change and the change in acceptance happened around
-- the same time — never that one caused the other. The panel says this out
-- loud; it is not a caveat to bury in a migration.
--
-- ── Shape / safety ───────────────────────────────────────────────────────────
-- SECURITY INVOKER, `language sql`, stable, schema-qualified, search_path
-- pinned to the live convention — the house pattern set by the analytics_*
-- functions in migration 000276. Invoker is right: proofs.ai_drafts already
-- has SELECT to authenticated and an RLS policy of `using (true)` for them
-- (verified against live), so the function needs no elevated rights and cannot
-- become a way to read something the caller could not read directly.
--
-- Grants: EXECUTE revoked from public/anon, granted to authenticated. Same
-- reach as the raw table it aggregates, which is the point — this widens
-- nothing. (Postgres grants EXECUTE to PUBLIC by default, so the revoke is the
-- load-bearing half.)
--
-- No index needed: proofs.ai_drafts already carries ai_drafts_created_idx on
-- (created_at desc), which is exactly the window filter below.
--
-- ⚠ Apply AFTER 000348 (feedback_match_quality) and 000351 (briefing_version):
-- this function reads both columns and will not create without them. Normal
-- ascending apply order does the right thing. The Drafts panel calls this RPC,
-- so apply before deploying the frontend or the panel shows its "couldn't
-- load" notice (which is at least honest, but pointless to ship).
--
-- Apply via MCP apply_migration / the dashboard SQL editor per the house
-- workflow — never CLI push.

create or replace function proofs.ai_draft_version_stats(p_days integer default 30)
returns table (
  version integer,        -- NULL = not recorded (pre-000351, or unreadable at draft time); 0 = the compiled fallback briefing
  drafts integer,         -- every ledger row that briefing produced, drafted or not
  matched integer,        -- of those, replies we can honestly score against the draft
  accepted integer,       -- of the matched, sent as-is or only lightly edited
  unrelated integer,      -- scored, but the reply was a different message entirely — excluded from matched/accepted
  first_at timestamptz,
  last_at timestamptz
)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  select
    d.briefing_version as version,
    count(*)::int as drafts,
    -- Scorable: a reply came back AND it was plausibly an edit of the draft.
    -- `is distinct from` (not `= 'edit'`) so unassessed NULL rows still count.
    count(*) filter (
      where d.edit_class is not null
        and d.feedback_match_quality is distinct from 'unrelated'
    )::int as matched,
    count(*) filter (
      where d.edit_class in ('sent_as_is', 'lightly_edited')
        and d.feedback_match_quality is distinct from 'unrelated'
    )::int as accepted,
    count(*) filter (
      where d.edit_class is not null
        and d.feedback_match_quality = 'unrelated'
    )::int as unrelated,
    min(d.created_at) as first_at,
    max(d.created_at) as last_at
  from proofs.ai_drafts d
  -- Bounded both ways: at least a day (a 0 would return nothing and read as
  -- "no drafts"), at most a year (nobody wants a stray 99999 scanning the lot).
  where d.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365))
  group by d.briefing_version
  order by min(d.created_at) desc;
$$;

comment on function proofs.ai_draft_version_stats(integer) is
  'Acceptance per AI-draft briefing version over the last p_days. Aggregated in SQL because the browser-side version was reading a 1000-row page of a 1753-row window and presenting it as fact. Excludes replies classified feedback_match_quality = ''unrelated'' (proof deliveries, order links) from matched/accepted and returns them separately; NULL quality means unassessed and still counts.';

revoke all on function proofs.ai_draft_version_stats(integer) from public, anon;
grant execute on function proofs.ai_draft_version_stats(integer) to authenticated;
