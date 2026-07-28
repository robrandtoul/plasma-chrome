-- Admin → Analytics: proof-annotation usage reporting
-- (migration 000347, docs/proof-annotation-proposal.md).
--
-- The feature shipped live with no usage surface at all — the same gap the
-- artwork check had before 000357/000358 — so the only way to answer "is
-- anyone actually using this?" was to query proof_annotations by hand. This
-- adds the read side. One json return so the tab makes a single round trip,
-- mirroring analytics_artwork_check (000358).
--
-- House pattern: language sql, stable, SECURITY INVOKER (so the caller's RLS
-- applies — the designer-name join therefore resolves for admins, exactly as
-- in analytics_by_designer), EXECUTE revoked from anon/public and granted to
-- authenticated only.
--
-- ── Deliberate reporting decisions ───────────────────────────────────────────
--
--  * THE TWO HALVES ARE NEVER AVERAGED. A designer callout and a customer pin
--    are different acts by different people with different denominators: a
--    callout is a designer choosing to annotate a version, a pin is a customer
--    choosing to point rather than describe. One combined "annotations used"
--    figure would be meaningless. They are reported side by side throughout,
--    and the two gates are independent booleans by design (000347), so either
--    half can legitimately be dark while the other is busy.
--
--  * UPTAKE COUNTS FROM FIRST OBSERVED USE, NOT THE WINDOW EDGE. Exactly the
--    trap 000358 documents: versions created before the feature existed could
--    never have carried a callout, and change requests submitted before it
--    existed could never have carried a pin. Counting them permanently
--    understates uptake — on a 30-day window two days after launch that reads
--    3/62 (5%) when almost none of those 62 were ever eligible. Nothing records
--    when the gate was flipped, so first-use is the proxy, per half, and the
--    `from` date is returned so the page states which period it is quoting.
--    Read the rate as "of the work that could have used it", not "of all work".
--
--  * DISTINCT PROOFS ARE REPORTED ALONGSIDE RAW COUNTS. Early usage concentrates
--    hard — a single designer trying the feature on one test fixture can put six
--    callouts on the board, which reads as far broader adoption than it is. The
--    proof and version counts are what make that concentration visible.
--    NO FIXTURE IS HARDCODED OUT: an exclusion list baked into a migration goes
--    stale silently and would quietly start hiding real customers. Showing the
--    spread and letting a human read it is the honest version.
--
--  * RESOLVE STATS COVER CUSTOMER PINS ONLY. Ticking off is a work queue for
--    pins the customer placed; a designer's own callout is not a task, so
--    folding it into the denominator would invent a permanent backlog of work
--    nobody was ever meant to do.
--
--  * THE GATES ARE RETURNED. Without them an empty tab reads as "nobody wants
--    this feature" when the truth may be "it is switched off".
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

create or replace function proofs.analytics_annotations(p_days int default 30)
  returns json
  language sql
  stable
  set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with win as (
    select now() - make_interval(days => greatest(coalesce(p_days, 30), 1)) as since
  ),
  -- Every annotation in the window, carrying its proof id so concentration is
  -- measurable (see the header note on distinct proofs).
  ann as (
    select a.*, v.proof_id
    from proofs.proof_annotations a
    join proofs.proof_versions v on v.id = a.proof_version_id, win
    where a.created_at >= win.since
  ),
  -- First observed use of each half, ever — the uptake denominators start here
  -- rather than at the window edge. Clamped to the window so a long-running
  -- feature reports the window the user actually asked for.
  starts as (
    select
      greatest(
        (select since from win),
        coalesce(
          (select min(created_at) from proofs.proof_annotations where author_kind = 'designer'),
          (select since from win)
        )
      ) as callout_from,
      -- ⚠ Anchored on the EVENT clock, not the pin's own created_at, because the
      -- denominator below counts change-request events. proof-action writes the
      -- event first and stamps each pin a moment later (created_at = pinBaseMs +
      -- i), so a `>= first pin` cutoff excludes the very change request that
      -- carried the first pin — dropping it from numerator AND denominator and
      -- under-reporting the rate. Caught by dry-running this against live: it
      -- read 2 of 13 where the truth is 3 of 14.
      greatest(
        (select since from win),
        coalesce(
          (select min(e.created_at) from proofs.proof_events e
            where exists (
              select 1 from proofs.proof_annotations a
              where a.proof_event_id = e.id and a.author_kind = 'customer'
            )),
          (select min(created_at) from proofs.proof_annotations where author_kind = 'customer'),
          (select since from win)
        )
      ) as pin_from
  )
  select json_build_object(
    'days', greatest(coalesce(p_days, 30), 1),
    'since', (select since from win),

    -- Whether each half is even switched on. An empty tab means something very
    -- different depending on these two.
    'gates', (
      select json_build_object(
        'callouts_enabled', coalesce(s.proof_callouts_enabled, false),
        'pins_enabled', coalesce(s.proof_pins_enabled, false)
      )
      from proofs.settings s where s.id = 1
    ),

    -- Headline counts, each half separately. `proofs` and `versions` are the
    -- spread; `notes` alone overstates adoption when one person is trying it out.
    'callouts', (
      select json_build_object(
        'notes', count(*),
        'versions', count(distinct proof_version_id),
        'proofs', count(distinct proof_id),
        'designers', count(distinct created_by) filter (where created_by is not null),
        'last_at', max(created_at)
      )
      from ann where author_kind = 'designer'
    ),
    'pins', (
      select json_build_object(
        'notes', count(*),
        'versions', count(distinct proof_version_id),
        'proofs', count(distinct proof_id),
        'change_requests', count(distinct proof_event_id) filter (where proof_event_id is not null),
        'last_at', max(created_at)
      )
      from ann where author_kind = 'customer'
    ),

    -- Designer uptake: of the versions created since callouts were first used,
    -- how many carry one. This is the "do designers reach for it" number.
    --
    -- ⚠ This is a COHORT measure, and its numerator will not match the raw
    -- `callouts.versions` count above — deliberately. A designer usually
    -- annotates a version that already exists, so a version created before the
    -- start point can still carry a callout; it is excluded from both sides of
    -- this fraction, since including it in the numerator while its 400 same-era
    -- siblings sit outside the denominator would flatter the rate. Read it as
    -- "of new versions, how many get annotated", never as "how many versions
    -- have a callout" — the page labels it that way for the same reason.
    'callout_adoption', (
      select json_build_object(
        'from', st.callout_from,
        'versions_created', count(pv.id),
        'versions_with_callout', count(pv.id) filter (where exists (
          select 1 from proofs.proof_annotations a
          where a.proof_version_id = pv.id and a.author_kind = 'designer'
        ))
      )
      from starts st
      -- LEFT so the row survives a window with no versions at all; a plain join
      -- would collapse to zero rows and return callout_adoption as null.
      left join proofs.proof_versions pv on pv.created_at >= st.callout_from
      group by st.callout_from
    ),

    -- Customer uptake: of the change requests submitted since pins were first
    -- used, how many arrived with a pin instead of prose alone. A pin is always
    -- written against its change-request event (proof-action), so the event is
    -- the correct denominator — not proofs, and not visits.
    'pin_adoption', (
      select json_build_object(
        'from', st.pin_from,
        'change_requests', count(e.id),
        'change_requests_with_pins', count(e.id) filter (where exists (
          select 1 from proofs.proof_annotations a
          where a.proof_event_id = e.id and a.author_kind = 'customer'
        )),
        -- How many pins land when someone does pin — one pin or a whole
        -- checklist is a materially different behaviour.
        'pins_on_those', (
          select count(*) from proofs.proof_annotations a
          where a.author_kind = 'customer' and a.created_at >= st.pin_from
        )
      )
      from starts st
      left join proofs.proof_events e
        on e.event_type = 'request_changes' and e.created_at >= st.pin_from
      group by st.pin_from
    ),

    -- Follow-through on the pins the customer placed. Reported over customer
    -- rows only (see the header). A high unresolved count is not necessarily a
    -- problem — the work may be done without anyone ticking the box — which is
    -- itself the thing worth seeing.
    'follow_through', (
      select json_build_object(
        'pins', count(*),
        'resolved', count(*) filter (where resolved_at is not null),
        'median_hours_to_resolve', percentile_cont(0.5) within group (
          order by extract(epoch from (resolved_at - created_at)) / 3600.0
        ) filter (where resolved_at is not null)
      )
      from ann where author_kind = 'customer'
    ),

    -- Who writes callouts. Customer pins have no profile to join to, so this
    -- is the designer half only, and the page labels it as such.
    'by_person', (
      select coalesce(json_agg(p order by p_notes desc), '[]'::json)
      from (
        select json_build_object(
          'created_by', a.created_by,
          'name', pr.full_name,
          'initials', pr.designer_initials,
          'colour', pr.designer_colour,
          'notes', count(*),
          'versions', count(distinct a.proof_version_id),
          'proofs', count(distinct a.proof_id),
          'last_at', max(a.created_at)
        ) as p, count(*) as p_notes
        from ann a
        left join proofs.profiles pr on pr.id = a.created_by
        where a.author_kind = 'designer' and a.created_by is not null
        group by a.created_by, pr.full_name, pr.designer_initials, pr.designer_colour
      ) x
    ),

    -- Weekly trend (Monday-anchored, oldest first), both halves on one axis so
    -- the two adoption curves are directly comparable.
    'weekly', (
      select coalesce(json_agg(w order by w_start), '[]'::json)
      from (
        select json_build_object(
          'week_start', date_trunc('week', created_at)::date,
          'callouts', count(*) filter (where author_kind = 'designer'),
          'pins', count(*) filter (where author_kind = 'customer'),
          'proofs', count(distinct proof_id)
        ) as w, date_trunc('week', created_at)::date as w_start
        from ann group by date_trunc('week', created_at)
      ) x
    )
  );
$$;

comment on function proofs.analytics_annotations(int) is
  'Admin → Analytics proof-annotation usage: designer callouts and customer pins reported separately — volume, spread across proofs, uptake against the work that could have used them, tick-off follow-through, per-designer counts and a weekly trend, over the last p_days.';

revoke all on function proofs.analytics_annotations(int) from public, anon;
grant execute on function proofs.analytics_annotations(int) to authenticated;
