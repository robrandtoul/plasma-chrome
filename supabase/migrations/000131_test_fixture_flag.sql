-- Migration 000131: is_test_fixture flag on contacts + auto-flag trigger.
--
-- Lightweight isolation step (Option B from the dev/prod topology
-- assessment). Test data and real data share the production database;
-- this column makes test fixtures filterable so dashboard counts,
-- reports, and any future "production-only" queries can exclude them
-- without ambiguity.
--
-- Auto-flag mechanism: a BEFORE INSERT trigger reads the contact's
-- email and flips is_test_fixture=true when it matches the established
-- testing convention (proofviewertest+sN@icloud.com). The trigger
-- only fires on INSERT — flag transitions are deliberate, not pattern-
-- driven. If a caller passes is_test_fixture=true explicitly (e.g. a
-- test script using a different email pattern), the trigger preserves
-- the explicit value and doesn't second-guess it.
--
-- Backfill: 10 existing contacts in production match
-- proofviewertest+%@icloud.com (verified — same set as the
-- name-pattern filter, no false positives). Backfill flags those 10
-- rows.
--
-- Partial index on is_test_fixture=true: tiny in size — single-digit
-- rows today, low double-digit growth even with active testing.
-- Indexed because production reports want a fast NOT is_test_fixture
-- filter; the inverse (find all test fixtures for cleanup) goes
-- through the cleanup script. Partial keeps the index to test rows
-- only.

begin;

-- ── 1. Column ──────────────────────────────────────────────────────────────

alter table contacts
  add column is_test_fixture boolean not null default false;

comment on column contacts.is_test_fixture is
  'When true, this contact and its associated proofs are test data, '
  'not a real customer. Set automatically by the contacts_flag_test_'
  'fixture trigger on insert when email matches the proofviewertest+'
  'sN@icloud.com convention; settable explicitly for test scripts '
  'that use a different email pattern. Production reports and '
  'dashboard aggregates should filter NOT is_test_fixture.';

create index contacts_is_test_fixture_idx
  on contacts (is_test_fixture)
  where is_test_fixture = true;

-- ── 2. Auto-flag trigger ───────────────────────────────────────────────────

create or replace function contacts_flag_test_fixture()
returns trigger
language plpgsql
as $$
begin
  -- Auto-flag based on the established testing email convention.
  -- Don't override an explicit is_test_fixture=true already set by
  -- the caller — deliberate test inserts via a script can use a
  -- different email pattern and still self-flag. Only fires on
  -- INSERT; flag transitions on existing rows must be deliberate.
  if not new.is_test_fixture
     and new.email ilike 'proofviewertest+%@icloud.com' then
    new.is_test_fixture := true;
  end if;
  return new;
end;
$$;

create trigger contacts_flag_test_fixture_trg
  before insert on contacts
  for each row
  execute function contacts_flag_test_fixture();

-- ── 3. Backfill existing test fixtures ─────────────────────────────────────
--
-- Both filters (email pattern, name pattern) identify exactly the
-- same 10 rows in production today with zero false positives —
-- verified before this migration was written. Email is the canonical
-- match here: it's the routing identifier and matches the testing
-- convention more reliably than the human-facing name.

update contacts
   set is_test_fixture = true
 where email ilike 'proofviewertest+%@icloud.com';

commit;
