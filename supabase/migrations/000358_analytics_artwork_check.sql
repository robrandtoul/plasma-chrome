-- Admin → Analytics: artwork-check usage reporting (docs/artwork-check-spec.md).
--
-- Reads the 000357 run ledger and answers the three questions asked of the
-- feature: how often is it run, by whom, and how often does it find something.
-- One json return so the page makes a single round trip, mirroring
-- analytics_funnel() (000276).
--
-- House pattern: language sql, stable, SECURITY INVOKER (so the caller's RLS
-- applies — the designer-name join therefore resolves for admins, exactly as
-- in analytics_by_designer), EXECUTE revoked from anon/public and granted to
-- authenticated only.
--
-- Deliberate reporting decisions, both of which would otherwise mislead:
--   * "Used by" counts source='designer' ONLY — a human clicking Run. Runs the
--     review page fires on open (auto_page) and runs the Dropbox-link trigger
--     fires (auto_folder_link) are reported separately, never folded into a
--     person's total. Per-person auto_page counts are still returned so the
--     two are visible side by side.
--   * Success rate excludes errors from the denominator where it is quoted as
--     "of the checks that completed" — the raw error count is returned too, so
--     the page can show both without inventing either.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

create or replace function proofs.analytics_artwork_check(p_days int default 30)
  returns json
  language sql
  stable
  set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
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

    -- Headline: every run in the window, however triggered.
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
        -- Runs that turned up at least one thing worth a human's eye.
        'runs_with_findings', count(*) filter (where verdict in ('flagged', 'defect'))
      )
      from runs
    ),

    -- The two gates have different base rates (print files after payment vs
    -- proof images before sending), so they are never averaged together.
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

    -- How runs are triggered — the context that stops the per-person table
    -- being read as the whole story.
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

    -- By whom. Ordered by deliberate runs; auto_page shown alongside so a
    -- designer who merely opened review pages is not read as a heavy user.
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

    -- Weekly trend (Monday-anchored, oldest first) for the frequency line.
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

    -- Adoption of the OPTIONAL gate. The order check is effectively mandatory
    -- (auto-run + the place-order gate), so its coverage is ~100% by
    -- construction and says nothing; the pre-send proof check is a button a
    -- designer chooses to press, so what share of new versions get one is the
    -- real usage signal.
    --
    -- The denominator starts at the FIRST pre-send check ever run, not at the
    -- window edge. Versions created before the feature existed could never
    -- have been checked, and counting them permanently understates uptake: on
    -- a 30-day window four days after launch that reads 19/421 (4%) when the
    -- honest figure is 19 of the versions actually eligible. `from` is
    -- returned so the page can say which period it is quoting.
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
      -- LEFT so the row survives a window with no versions at all; a plain
      -- join would collapse to zero rows and return proof_adoption as null.
      left join proofs.proof_versions pv on pv.created_at >= f.start_at
      group by f.start_at
    ),

    -- What it costs to run. Tokens only; no pricing is assumed here, since the
    -- model is admin-switchable and rates change.
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
$$;

comment on function proofs.analytics_artwork_check(int) is
  'Admin → Analytics artwork-check usage: run frequency, who ran them (deliberate runs only), verdict mix, weekly trend, pre-send adoption and token spend, over the last p_days.';

revoke all on function proofs.analytics_artwork_check(int) from public, anon;
grant execute on function proofs.analytics_artwork_check(int) to authenticated;
