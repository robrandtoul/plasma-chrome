-- Migration 000152: dashboard Phase 1 — tiles, search, designer chips.
--
-- Backs the redesigned designer dashboard at `/`. Three additions:
--
--   1. profiles.designer_colour + profiles.designer_initials
--      Per-designer presentation hooks for the row avatars on the new
--      project list. Stored on profiles (not auth.users.raw_user_meta_data
--      as the brief originally suggested) because the existing app pattern
--      already extends profiles for full_name / role / helpscout_user_id,
--      and the dashboard view we add below joins through profiles to
--      surface them — running as the view's owner sidesteps the
--      admin-only RLS policy on profiles, so the field is readable to
--      every authenticated designer through the view without granting
--      base-table SELECT.
--
--   2. public_dashboard_projects view
--      One-row-per-proof shape used by the new dashboard query: proof +
--      contact + company + the latest proof_version (with designer
--      attribution from profiles) + the latest event from
--      dashboard_latest_events. Replaces the chained PostgREST nested-
--      select that the old dashboard issued, which was already brittle
--      and would not scale to thousands of projects. REVOKE from anon
--      and PUBLIC mirrors the 000122 / 000127 / 000151 pattern.
--
--   3. proofs_needing_attention() + dashboard_tile_counts() functions
--      The needs-attention rules for Phase 1 are deliberately
--      hardcoded; Phase 2 swaps the function body for a configurable
--      rules engine without touching the dashboard query. Keeping the
--      logic behind a SQL function isolates that future swap to one
--      file. dashboard_tile_counts() returns the four tile values in a
--      single round-trip so the dashboard doesn't need to fan out four
--      aggregate queries on first paint.
--
-- Rules baked into proofs_needing_attention():
--
--   a. status='in_progress' AND the current proof_versions row has had
--      no non-bot proof_version_views since it was created, given that
--      at least 3 working days (Mon–Fri) have elapsed since creation.
--      "Working days" is computed inline via generate_series filtered to
--      weekdays — public-holiday awareness is Phase 2.
--
--   b. proofs.last_activity_at is in the (now() - 30d, now() - 25d)
--      five-day band, regardless of status, EXCLUDING approved /
--      abandoned proofs. This catches projects that are about to slip
--      into the dormant cliff (000019 marks them dormant at 30 days)
--      so the designer has a window to ping the customer first.
--
-- dashboard_tile_counts() definitions:
--
--   needs_attention      — count of proofs_needing_attention()
--   awaiting_customer    — status='in_progress' AND the current version
--                           has no customer-side activity (no non-bot
--                           proof_version_views, no proof_events of
--                           type 'approve' or 'request_changes' for the
--                           current version). The brief framed this as
--                           "most recent dashboard_latest_events row is
--                           a designer-side action"; the
--                           absence-of-customer-activity formulation is
--                           equivalent in Phase 1 (the only
--                           designer-side action that lands in
--                           dashboard_latest_events today is
--                           designer_override_approve, which is rare)
--                           and avoids needing a "designer-side" event
--                           type that doesn't exist yet.
--   dormant              — status='dormant'
--   approved_this_week   — status='approved' AND approved_at within 7d
--
-- All three additions are idempotent (column add uses IF NOT EXISTS,
-- functions and view use CREATE OR REPLACE).

begin;

-- ── 1. Designer presentation columns + backfill ─────────────────────────────

alter table profiles
  add column if not exists designer_colour text
    check (designer_colour in ('blue', 'teal', 'coral', 'purple'));

alter table profiles
  add column if not exists designer_initials text;

comment on column profiles.designer_colour is
  'Stable per-designer colour used by the dashboard project-row avatars. '
  'One of blue / teal / coral / purple. Rob is pinned to blue; everyone '
  'else gets a deterministic colour based on profile id so the same '
  'designer always renders the same avatar.';

comment on column profiles.designer_initials is
  'Pre-computed 1–2 char initials shown inside the dashboard avatar '
  'circle. Stored rather than computed on read so the dashboard query '
  'stays a single SELECT and so admins can override the auto-derived '
  'initials by hand if a name produces an awkward pair.';

-- Backfill: derive initials from full_name (first letter of the first
-- and last whitespace-separated tokens), and assign a colour. Rob gets
-- blue; everyone else cycles through teal / coral / purple based on a
-- stable hash of the profile id so two designers don't accidentally
-- collide.
update profiles
set
  designer_initials = coalesce(
    designer_initials,
    nullif(
      upper(
        coalesce(left(split_part(full_name, ' ', 1), 1), '')
        ||
        case
          when full_name ~ ' '
            then left(split_part(full_name, ' ', array_length(string_to_array(full_name, ' '), 1)), 1)
          else ''
        end
      ),
      ''
    )
  ),
  designer_colour = coalesce(
    designer_colour,
    case
      when id = (select id from auth.users where email = 'rob.randtoul@gmail.com')
        then 'blue'
      else (array['teal', 'coral', 'purple'])[
        (abs(hashtext(id::text)) % 3) + 1
      ]
    end
  )
where designer_initials is null
   or designer_colour is null;

-- ── 2. Trigger: new profiles auto-fill designer_colour + initials ────────────
--
-- handle_new_user() (000002) inserts a bare profiles row on auth signup,
-- so designer_colour / designer_initials would otherwise stay null
-- forever for fresh users. Compute on insert / on full_name update so
-- the dashboard always has something to render.

create or replace function set_designer_presentation()
returns trigger
language plpgsql
as $$
begin
  if new.designer_initials is null and new.full_name is not null then
    new.designer_initials := nullif(
      upper(
        coalesce(left(split_part(new.full_name, ' ', 1), 1), '')
        ||
        case
          when new.full_name ~ ' '
            then left(split_part(new.full_name, ' ', array_length(string_to_array(new.full_name, ' '), 1)), 1)
          else ''
        end
      ),
      ''
    );
  end if;

  if new.designer_colour is null then
    new.designer_colour := (array['teal', 'coral', 'purple'])[
      (abs(hashtext(new.id::text)) % 3) + 1
    ];
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_designer_presentation on profiles;
create trigger trg_set_designer_presentation
  before insert or update of full_name on profiles
  for each row
  execute function set_designer_presentation();

-- ── 3. proofs_needing_attention() ────────────────────────────────────────────

create or replace function proofs_needing_attention()
returns uuid[]
language sql
stable
as $$
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  rule_a as (
    -- status='in_progress' AND ≥3 working days since version created
    -- AND no non-bot view since creation.
    select cv.proof_id
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    where p.status = 'in_progress'
      and (
        select count(*)
        from generate_series(
          date_trunc('day', cv.created_at),
          date_trunc('day', now()),
          interval '1 day'
        ) d
        where extract(dow from d) not in (0, 6)
      ) >= 4   -- creation day + 3 weekdays inclusive
      and not exists (
        select 1
        from proof_version_views v
        where v.proof_version_id = cv.version_id
          and v.is_bot = false
          and v.viewed_at >= cv.created_at
      )
  ),
  rule_b as (
    -- last_activity_at in the 25–30 day band, not yet
    -- terminal (approved / abandoned).
    select id as proof_id
    from proofs
    where last_activity_at between now() - interval '30 days'
                              and now() - interval '25 days'
      and status not in ('approved', 'abandoned')
  )
  select coalesce(array_agg(distinct proof_id), '{}'::uuid[])
  from (
    select proof_id from rule_a
    union
    select proof_id from rule_b
  ) u;
$$;

grant execute on function proofs_needing_attention() to authenticated;

comment on function proofs_needing_attention() is
  'Phase 1 hard-coded rules backing the "Needs attention" dashboard '
  'tile. Returns proof ids matching either: (a) in_progress with the '
  'current version >=3 working days old and no non-bot views since '
  'creation, or (b) any non-terminal proof whose last_activity_at sits '
  'in the 25–30 day pre-dormant warning band. Phase 2 swaps the body '
  'for a rules-engine driven implementation without changing the '
  'function signature.';

-- ── 4. dashboard_tile_counts() ───────────────────────────────────────────────

create or replace function dashboard_tile_counts()
returns table (
  needs_attention    int,
  awaiting_customer  int,
  dormant            int,
  approved_this_week int
)
language sql
stable
as $$
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  awaiting as (
    -- in_progress projects with a current version that has no
    -- customer-side activity (no non-bot views, no approve /
    -- request_changes events on the current version).
    select cv.proof_id
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    where p.status = 'in_progress'
      and not exists (
        select 1
        from proof_version_views v
        where v.proof_version_id = cv.version_id
          and v.is_bot = false
      )
      and not exists (
        select 1
        from proof_events e
        where e.proof_version_id = cv.version_id
          and e.event_type in ('approve', 'request_changes')
      )
  )
  select
    coalesce(array_length(proofs_needing_attention(), 1), 0) as needs_attention,
    (select count(*)::int from awaiting)                     as awaiting_customer,
    (select count(*)::int from proofs where status = 'dormant') as dormant,
    (select count(*)::int from proofs
       where status = 'approved'
         and approved_at >= now() - interval '7 days')        as approved_this_week;
$$;

grant execute on function dashboard_tile_counts() to authenticated;

comment on function dashboard_tile_counts() is
  'Single-round-trip count provider for the four dashboard stat tiles. '
  'See migration 000152 header for the per-tile rule definitions.';

-- ── 5. public_dashboard_projects view ───────────────────────────────────────
--
-- One row per proof, joined to the latest version, the contact, the
-- company, the version creator (profiles), and the latest event from
-- dashboard_latest_events. Replaces the multi-table nested-select the
-- old dashboard issued. RLS hand-off mirrors the project pattern: the
-- view runs as its owner so it can read past the profiles admin-only
-- RLS, and we explicitly REVOKE from anon / public.

create or replace view public_dashboard_projects as
  with current_versions as (
    -- proofs.is_current is the canonical "current version" flag
    -- (000011) — exactly one row per proof, preferred over an
    -- ORDER BY version_number desc which would silently pick a
    -- different row if the trigger ever drifts. Capped per proof
    -- via a self-anchored DISTINCT ON for safety.
    select distinct on (pv.proof_id)
      pv.proof_id,
      pv.id              as version_id,
      pv.version_number,
      pv.material_display,
      pv.created_at      as version_created_at,
      pv.created_by      as designer_user_id
    from proof_versions pv
    where pv.is_current
    order by pv.proof_id, pv.version_number desc
  ),
  latest_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_event_at,
      e.event_type    as latest_event_type,
      e.actor_name    as latest_event_actor
    from dashboard_latest_events e
    order by e.proof_id, e.created_at desc
  ),
  current_view_state as (
    -- Latest non-bot view for the current version, used by the
    -- existing viewed-state dot. Capped at one row per proof.
    select distinct on (cv.proof_id)
      cv.proof_id,
      v.viewed_at as current_version_viewed_at
    from proof_versions cv
    join proof_version_views v on v.proof_version_id = cv.id
    where cv.is_current and v.is_bot = false
    order by cv.proof_id, v.viewed_at desc
  )
  select
    p.id                                                     as proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id                                                     as contact_id,
    c.full_name                                              as contact_name,
    c.email                                                  as contact_email,
    co.id                                                    as company_id,
    co.name                                                  as company_name,
    cv.version_id                                            as current_version_id,
    cv.version_number                                        as current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name                                             as designer_name,
    pr.designer_initials,
    pr.designer_colour,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles), and the latest dashboard_latest_events row. View runs as '
  'owner so it bypasses the profiles admin-only SELECT RLS — the only '
  'columns surfaced from profiles are presentation metadata '
  '(designer_initials, designer_colour, full_name) which are safe to '
  'expose to every authenticated designer.';

commit;
