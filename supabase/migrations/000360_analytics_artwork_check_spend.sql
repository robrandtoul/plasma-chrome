-- Admin → Analytics: what the artwork check costs to run.
--
-- The usage tab already reported tokens, but a token total can't be turned
-- into money: the four token buckets bill at different rates (output is 5x
-- input; a cache write is 1.25x input and a cache read 0.1x), and the rates
-- themselves differ per model — the check is admin-switchable between Opus
-- 4.8, Opus 5, Sonnet 5 and Fable 5, and Fable costs double Opus. A single
-- blended total therefore can't be priced without inventing a rate.
--
-- This adds a `spend` key: one row per (check_kind, model) with its four token
-- sums and run count, so the page can price each bucket at that model's own
-- rate and still aggregate by model or by gate. Rates deliberately live in the
-- frontend (src/lib/aiModelPricing.ts) rather than here — they change when
-- Anthropic changes them, and a published price list has no business being
-- pinned inside a migration that needs a DB apply to correct.
--
-- The existing `cost` key is left exactly as it was: it backs the token
-- footnote already on the page, and leaving it alone means a frontend deployed
-- before this migration keeps working unchanged.
--
-- Everything else in the function is byte-for-byte the 000358 body.
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
    -- Priceable spend buckets: one row per (gate, model). Split by model
    -- because rates differ per model, and by gate so the page can say what the
    -- pre-send check costs separately from the pre-print one. '(unrecorded)'
    -- is the pre-ledger backfill, which has no model and prices as unknown.
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
$$;

comment on function proofs.analytics_artwork_check(int) is
  'Admin → Analytics artwork-check usage: run frequency, who ran them (deliberate runs only), verdict mix, weekly trend, pre-send adoption, per-(gate, model) spend buckets and token totals, over the last p_days.';

revoke all on function proofs.analytics_artwork_check(int) from public, anon;
grant execute on function proofs.analytics_artwork_check(int) to authenticated;
