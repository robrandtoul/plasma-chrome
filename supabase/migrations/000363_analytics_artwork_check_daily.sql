-- Admin → Analytics → Artwork checks: a per-DAY run count alongside the
-- existing per-week one.
--
-- The weekly bars answer "is this feature being used at all"; they can't answer
-- "what does a normal day look like", which is the question when you're judging
-- whether a spike was one busy afternoon or a fortnight of steady work. Four
-- weekly bars over a 30-day window is too coarse to see that.
--
-- ⚠ Re-emitted from the LIVE definition (pg_get_functiondef, read 2026-07-28),
-- not from 000358 — this function has already been extended once since then
-- (000360 added `spend`), and rebuilding it from the older migration file would
-- silently drop that block and break the cost panel. Everything below is the
-- live body verbatim plus the one new 'daily' key. Same trap the 000347 header
-- documents for public_settings(); if you extend this again, read live first.
--
-- ── Two deliberate decisions in the daily block ──────────────────────────────
--
--  * EMPTY DAYS ARE EMITTED AS ZEROS. A plain `group by date_trunc('day')`
--    returns only days that HAVE runs, so a chart drawn from it silently closes
--    the gaps and a feature used twice a fortnight renders as an unbroken run of
--    daily activity — the axis itself does the lying, and nothing on screen
--    hints at it. generate_series over the window fixes the denominator of the
--    picture: a quiet day is a visible gap, which is exactly the signal being
--    looked for. (The weekly block keeps its original shape: it has the same
--    flaw, but at 4-13 bars a missing week is obvious, and changing it would
--    alter a chart nobody asked to change.)
--
--  * DAYS ARE LONDON DAYS, NOT UTC DAYS. `ran_at` is timestamptz and the server
--    is UTC, so a bare ::date puts a check run at 17:30 on a British summer
--    evening into the FOLLOWING day's bar. Nobody reading "checks per day"
--    means UTC midnight; they mean the working day they remember. The window
--    bounds are computed in the same zone so the series can't be off by one at
--    either end.
--
-- Additive: only a new key on the returned json. The existing tab keeps working
-- untouched if the frontend deploys first or not at all.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

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

    -- NEW: one row per calendar day in the window, including days with no runs
    -- (see the header — a chart built from present-days-only draws a lie).
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
    )
  );
$function$;

comment on function proofs.analytics_artwork_check(int) is
  'Admin → Analytics artwork-check usage: run frequency (per day and per week), who ran them (deliberate runs only), verdict mix, pre-send adoption and token spend, over the last p_days.';

revoke all on function proofs.analytics_artwork_check(int) from public, anon;
grant execute on function proofs.analytics_artwork_check(int) to authenticated;
