-- Migration 000155: Pinned and Team sections on the dashboard.
--
-- New table proof_pins. Two scopes share one table:
--
--   * scope='mine' — personal pin for one designer. user_id holds
--     that designer's auth.users.id.
--   * scope='team' — team-wide pin visible to everyone. user_id is
--     null (the pin doesn't belong to any single designer).
--
-- The shape was kept as a single table rather than two siblings
-- because every read path (the dashboard fetch, the row overflow
-- menu's "is this pinned?" check) cares about both scopes
-- simultaneously, and a polymorphic `(proof_id, scope, user_id?)`
-- key is exactly what those read paths want.
--
-- pinned_by is denormalised audit attribution: for scope='mine' it
-- always equals user_id, for scope='team' it's whichever designer
-- placed the pin. We keep both columns even on mine rows so the
-- read path doesn't need to branch on scope to find "who did this".
--
-- The dashboard view (public_dashboard_projects, last touched in
-- 000154) deliberately doesn't carry pin state — pins are joined
-- client-side from a separate fetch. Reasoning: the per-user
-- dimension on mine pins would force the view to take auth.uid()
-- into account, which crosses the view-runs-as-owner boundary; and
-- pins change far more often than the rest of the dashboard data,
-- so refetching them as a small standalone query is simpler than
-- the full dashboard refresh that a view-level join would force.

begin;

-- ── 1. proof_pins table ─────────────────────────────────────────────────────

create table proof_pins (
  id          uuid        primary key default gen_random_uuid(),
  proof_id    uuid        not null references proofs(id)     on delete cascade,
  scope       text        not null check (scope in ('mine', 'team')),
  -- mine pins must reference a designer; team pins must not. If a
  -- designer is later deleted via the auth flow, their mine pins
  -- cascade away (their personal organisation goes with them);
  -- pinned_by on team pins they made falls back to null via the
  -- separate FK below so the team pin itself stays.
  user_id     uuid        references auth.users(id) on delete cascade,
  pinned_at   timestamptz not null default now(),
  pinned_by   uuid        references auth.users(id) on delete set null,
  constraint proof_pins_scope_user_check check (
    (scope = 'mine' and user_id is not null) or
    (scope = 'team' and user_id is null)
  )
);

comment on table proof_pins is
  'Designer-managed dashboard pins. scope="mine" rows belong to a '
  'single designer (user_id required); scope="team" rows are '
  'organisation-wide (user_id null). Read by the dashboard pinned/'
  'team sections via a small separate fetch — not joined into '
  'public_dashboard_projects.';

-- ── 2. Uniqueness via partial indexes ───────────────────────────────────────
--
-- Two partial unique indexes rather than one composite UNIQUE so
-- the team-pin uniqueness check works (NULL != NULL in Postgres
-- unique semantics, so a (proof_id, user_id) UNIQUE would happily
-- accept duplicate (proof_id, null) rows on the team scope).

create unique index proof_pins_mine_unique
  on proof_pins (proof_id, user_id)
  where scope = 'mine';

create unique index proof_pins_team_unique
  on proof_pins (proof_id)
  where scope = 'team';

-- ── 3. Read-path indexes ─────────────────────────────────────────────────────
--
-- (user_id, scope) — "load my mine-pins". (proof_id, scope) — used
-- by the toggle path on the row overflow menu to check whether the
-- current proof already has a team pin or a mine-pin from auth.uid().

create index proof_pins_user_scope_idx on proof_pins (user_id, scope);
create index proof_pins_proof_scope_idx on proof_pins (proof_id, scope);

-- ── 4. RLS ──────────────────────────────────────────────────────────────────

alter table proof_pins enable row level security;

-- Read: every signed-in designer can see every pin (small data, no
-- privacy concern; team pins must be visible to everyone by design,
-- and mine pins are useful enough that "someone else can see I
-- pinned that proof" isn't worth the policy complexity to hide).
create policy "proof_pins: authenticated read"
  on proof_pins for select
  to authenticated
  using (true);

-- Mine pins: only the user themselves can write/remove their own.
create policy "proof_pins: mine insert"
  on proof_pins for insert
  to authenticated
  with check (scope = 'mine' and user_id = auth.uid());

create policy "proof_pins: mine delete"
  on proof_pins for delete
  to authenticated
  using (scope = 'mine' and user_id = auth.uid());

-- Team pins: any authenticated designer can pin/unpin.
create policy "proof_pins: team insert"
  on proof_pins for insert
  to authenticated
  with check (scope = 'team' and user_id is null);

create policy "proof_pins: team delete"
  on proof_pins for delete
  to authenticated
  using (scope = 'team');

commit;
