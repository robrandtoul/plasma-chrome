-- 000385: keep every artwork/proof check report — and its ticks — readable.
--
-- The check stores only its LATEST report per target (orders.artwork_check /
-- proof_versions.artwork_check): every re-run overwrites the slot wholesale,
-- taking the predecessor's findings, its designer ticks ("Mark as addressed",
-- PR #637) and its investigations with it. The 000357 run ledger already keeps
-- one append-only row per run, but only the numbers — verdict, flag counts,
-- cost — never the content. So "what did the check say before the fix?" and
-- "who dismissed that advisory, and why?" become unanswerable one re-run
-- later, and the tick-reason data (the check's tuning signal) is perishable.
--
-- Two changes:
--
-- 1. `report jsonb` on proofs.artwork_check_runs. The artwork-check function
--    now writes the full report onto the run's ledger row at finish, and the
--    tick / investigation branches MIRROR their updates onto the matching row
--    (matched on order_id/proof_version_id + ran_at = the report's checked_at
--    — unique per run), so the row always holds the report's final state when
--    a re-run replaces the live slot. Best-effort on the function side: a
--    mirror miss is logged, never surfaced; the live slot stays authoritative
--    for the open page. Additive and inert until the function redeploy; the
--    function's ledger insert retries without the column on a pre-migration
--    database, so either deploy order loses nothing. No new grants needed —
--    the column inherits the table's 000357 matrix (authenticated SELECT,
--    which the report-card "Previous runs" list reads directly; designers
--    already read these same reports off the live slots, so no new exposure;
--    anon has nothing).
--
-- 2. `analytics_artwork_check` gains an `acks` key: tick totals + reason mix
--    ("fixed in the artwork" / "intentional — confirmed" / "the check misread
--    it"), windowed by the TICK's own timestamp (not the run's — ticking an
--    old report today is today's feedback), plus a breakdown of misread-ticked
--    advisories by field and the most recent examples. "Misread" is the
--    load-bearing category: a class of advisory that designers repeatedly tick
--    as misread is an over-flagging pattern, and this panel is where it
--    becomes visible instead of archaeology. Findings are matched to their
--    ticks by RECOMPUTING each finding's ack key ('f:' || card || '::' ||
--    field || '::' || printed — acks.ts) rather than parsing keys apart,
--    because card labels and printed values are free text that may contain
--    the delimiter.
--
-- ⚠ Function body re-emitted from the LIVE pg_get_functiondef (read 2026-08-06)
-- — NOT from 000363's file — per the house rule that migration files lag live
-- (000360's spend/cost and 000363's daily keys are present below because live
-- carries them; rebuilding from an older file would silently drop them, the
-- exact trap 000363's own header documents). The `acks` key is the ONLY
-- change. CREATE OR REPLACE preserves the existing grants and search_path.
--
-- Apply via MCP apply_migration / the dashboard SQL editor against the merged
-- stock project (bjvinrzbdrwebylkmbwy), per the house workflow.

alter table proofs.artwork_check_runs add column if not exists report jsonb;

comment on column proofs.artwork_check_runs.report is
  'Full ArtworkCheckReport jsonb for this run, written at finish and re-mirrored whenever a tick or investigation lands on it — so superseded reports (and their acknowledgements) stay readable after a re-run overwrites the live slot. NULL on runs recorded before 000385.';

create or replace function proofs.analytics_artwork_check(p_days integer default 30)
returns json
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with win as (
    select now() - make_interval(days => greatest(coalesce(p_days, 30), 1)) as since
  ),
  runs as (
    select r.*
    from proofs.artwork_check_runs r, win
    where r.ran_at >= win.since
  )
  select json_build_object(
    'days', greatest(coalesce(p_days, 30), 1),
    'since', (select since from win),
    'totals', (
      select json_build_object(
        'runs', count(*),
        'clear', count(*) filter (where verdict = 'clear'),
        'flagged', count(*) filter (where verdict = 'flagged'),
        'defect', count(*) filter (where verdict = 'defect'),
        'error', count(*) filter (where verdict = 'error'),
        'reruns', count(*) filter (where is_rerun),
        'manual_runs', count(*) filter (where source = 'designer'),
        'auto_runs', count(*) filter (where source in ('auto_page', 'auto_folder_link')),
        'people', count(distinct ran_by) filter (where source = 'designer' and ran_by is not null),
        'orders_checked', count(distinct order_id) filter (where order_id is not null),
        'versions_checked', count(distinct proof_version_id) filter (where proof_version_id is not null),
        'flags_found', coalesce(sum(flag_count), 0),
        'defects_found', coalesce(sum(defect_count), 0),
        'runs_with_findings', count(*) filter (where verdict in ('flagged', 'defect'))
      )
      from runs
    ),
    'by_kind', (
      select coalesce(json_agg(k order by k_runs desc), '[]'::json)
      from (
        select json_build_object(
          'kind', check_kind,
          'runs', count(*),
          'clear', count(*) filter (where verdict = 'clear'),
          'flagged', count(*) filter (where verdict = 'flagged'),
          'defect', count(*) filter (where verdict = 'defect'),
          'error', count(*) filter (where verdict = 'error'),
          'manual_runs', count(*) filter (where source = 'designer'),
          'flags_found', coalesce(sum(flag_count), 0),
          'defects_found', coalesce(sum(defect_count), 0)
        ) as k, count(*) as k_runs
        from runs group by check_kind
      ) x
    ),
    'by_source', (
      select coalesce(json_agg(s order by s_runs desc), '[]'::json)
      from (
        select json_build_object(
          'source', source,
          'runs', count(*),
          'clear', count(*) filter (where verdict = 'clear'),
          'flagged', count(*) filter (where verdict = 'flagged'),
          'defect', count(*) filter (where verdict = 'defect'),
          'error', count(*) filter (where verdict = 'error')
        ) as s, count(*) as s_runs
        from runs group by source
      ) x
    ),
    'by_person', (
      select coalesce(json_agg(p order by p_manual desc, p_runs desc), '[]'::json)
      from (
        select json_build_object(
          'ran_by', r.ran_by,
          'name', pr.full_name,
          'initials', pr.designer_initials,
          'colour', pr.designer_colour,
          'manual_runs', count(*) filter (where r.source = 'designer'),
          'auto_page_runs', count(*) filter (where r.source = 'auto_page'),
          'order_runs', count(*) filter (where r.source = 'designer' and r.check_kind = 'order'),
          'proof_runs', count(*) filter (where r.source = 'designer' and r.check_kind = 'proof'),
          'clear', count(*) filter (where r.source = 'designer' and r.verdict = 'clear'),
          'flagged', count(*) filter (where r.source = 'designer' and r.verdict = 'flagged'),
          'defect', count(*) filter (where r.source = 'designer' and r.verdict = 'defect'),
          'error', count(*) filter (where r.source = 'designer' and r.verdict = 'error'),
          'last_run_at', max(r.ran_at) filter (where r.source = 'designer')
        ) as p,
        count(*) filter (where r.source = 'designer') as p_manual,
        count(*) as p_runs
        from runs r
        left join proofs.profiles pr on pr.id = r.ran_by
        where r.ran_by is not null and r.source in ('designer', 'auto_page')
        group by r.ran_by, pr.full_name, pr.designer_initials, pr.designer_colour
      ) x
    ),

    -- One row per calendar day in the window, including days with no runs.
    -- LEFT JOIN, so count(r.id) rather than count(*): count(*) counts the
    -- generated day row itself and would report every empty day as 1 run.
    'daily', (
      select coalesce(json_agg(d order by d_day), '[]'::json)
      from (
        select json_build_object(
          'day', g.day::date,
          'runs', count(r.id),
          'clear', count(r.id) filter (where r.verdict = 'clear'),
          'flagged', count(r.id) filter (where r.verdict = 'flagged'),
          'defect', count(r.id) filter (where r.verdict = 'defect'),
          'error', count(r.id) filter (where r.verdict = 'error'),
          'manual_runs', count(r.id) filter (where r.source = 'designer')
        ) as d, g.day as d_day
        from generate_series(
          ((select since from win) at time zone 'Europe/London')::date,
          (now() at time zone 'Europe/London')::date,
          interval '1 day'
        ) as g(day)
        left join runs r
          on (r.ran_at at time zone 'Europe/London')::date = g.day::date
        group by g.day
      ) x
    ),

    'weekly', (
      select coalesce(json_agg(w order by w_start), '[]'::json)
      from (
        select json_build_object(
          'week_start', date_trunc('week', ran_at)::date,
          'runs', count(*),
          'clear', count(*) filter (where verdict = 'clear'),
          'flagged', count(*) filter (where verdict = 'flagged'),
          'defect', count(*) filter (where verdict = 'defect'),
          'error', count(*) filter (where verdict = 'error'),
          'manual_runs', count(*) filter (where source = 'designer')
        ) as w, date_trunc('week', ran_at)::date as w_start
        from runs group by date_trunc('week', ran_at)
      ) x
    ),
    'proof_adoption', (
      select json_build_object(
        'from', f.start_at,
        'versions_created', count(pv.id),
        'versions_checked', count(pv.id) filter (where exists (
          select 1 from proofs.artwork_check_runs r
          where r.proof_version_id = pv.id and r.ran_at >= f.start_at
        ))
      )
      from (
        select greatest(
          (select since from win),
          coalesce(
            (select min(ran_at) from proofs.artwork_check_runs where check_kind = 'proof'),
            (select since from win)
          )
        ) as start_at
      ) f
      left join proofs.proof_versions pv on pv.created_at >= f.start_at
      group by f.start_at
    ),
    'spend', (
      select coalesce(json_agg(s order by s_runs desc), '[]'::json)
      from (
        select json_build_object(
          'kind', check_kind,
          'model', coalesce(model, '(unrecorded)'),
          'runs', count(*),
          'input_tokens', coalesce(sum(input_tokens), 0),
          'output_tokens', coalesce(sum(output_tokens), 0),
          'cache_read_tokens', coalesce(sum(cache_read_tokens), 0),
          'cache_write_tokens', coalesce(sum(cache_write_tokens), 0)
        ) as s, count(*) as s_runs
        from runs group by check_kind, coalesce(model, '(unrecorded)')
      ) x
    ),
    'cost', (
      select json_build_object(
        'input_tokens', coalesce(sum(input_tokens), 0),
        'output_tokens', coalesce(sum(output_tokens), 0),
        'cache_read_tokens', coalesce(sum(cache_read_tokens), 0),
        'cache_write_tokens', coalesce(sum(cache_write_tokens), 0),
        'models', (
          select coalesce(json_agg(m order by m_runs desc), '[]'::json)
          from (
            select json_build_object('model', coalesce(model, '(unrecorded)'), 'runs', count(*)) as m,
                   count(*) as m_runs
            from runs group by model
          ) y
        )
      )
      from runs
    ),

    -- NEW (000385): the advisory tick-off feedback. Windowed by each tick's
    -- own `at` — a designer working an old report today is today's feedback —
    -- so this deliberately reads the full ledger, not the run-windowed CTE.
    -- One tick lives on exactly one ledger row (the mirror matches on
    -- ran_at = the report's checked_at, unique per run), so no dedupe.
    'acks', (
      with t as (
        select r.id as run_id,
               r.check_kind,
               a.key as ack_key,
               a.value->>'reason' as reason,
               nullif(a.value->>'at', '')::timestamptz as ticked_at,
               r.report as rep
        from proofs.artwork_check_runs r
        cross join lateral jsonb_each(coalesce(r.report->'acknowledgements', '{}'::jsonb)) a
        where r.report is not null
      ),
      tw as (
        select t.* from t, win where t.ticked_at is not null and t.ticked_at >= win.since
      ),
      misread as (
        select tw.ticked_at, tw.check_kind,
               f.value->>'field' as field,
               f.value->>'printed' as printed,
               f.value->>'supplied' as supplied,
               c.value->>'label' as card
        from tw
        cross join lateral jsonb_array_elements(coalesce(tw.rep->'cards', '[]'::jsonb)) c
        cross join lateral jsonb_array_elements(coalesce(c.value->'findings', '[]'::jsonb)) f
        where tw.reason = 'incorrect'
          and tw.ack_key = 'f:' || (c.value->>'label') || '::' || (f.value->>'field') || '::' || (f.value->>'printed')
        union all
        select tw.ticked_at, tw.check_kind,
               'correction', cor.value->>'quote', '', ''
        from tw
        cross join lateral jsonb_array_elements(coalesce(tw.rep->'corrections', '[]'::jsonb)) cor
        where tw.reason = 'incorrect'
          and tw.ack_key = 'c:' || (cor.value->>'quote')
      )
      select json_build_object(
        'ticked_total', (select count(*) from tw),
        'reports_with_ticks', (select count(distinct run_id) from tw),
        'by_reason', json_build_object(
          'fixed', (select count(*) from tw where reason = 'fixed'),
          'intentional', (select count(*) from tw where reason = 'intentional'),
          'incorrect', (select count(*) from tw where reason = 'incorrect')
        ),
        'misread_by_field', (
          select coalesce(json_agg(m order by m_count desc), '[]'::json)
          from (
            select json_build_object('field', field, 'count', count(*)) as m, count(*) as m_count
            from misread group by field
          ) x
        ),
        'recent_misread', (
          select coalesce(json_agg(rm order by rm_at desc), '[]'::json)
          from (
            select json_build_object(
              'at', ticked_at,
              'kind', check_kind,
              'field', field,
              'printed', left(coalesce(printed, ''), 120),
              'supplied', left(coalesce(supplied, ''), 120),
              'card', left(coalesce(card, ''), 80)
            ) as rm, ticked_at as rm_at
            from misread
            order by ticked_at desc
            limit 12
          ) x
        )
      )
    )
  );
$function$;
