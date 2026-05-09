-- Migration 000159: tighten proof_pins insert policies so the
-- pinned_by audit-attribution column can't be spoofed.
--
-- Bug:
--   The "proof_pins: mine insert" and "proof_pins: team insert"
--   policies from 000155 only constrain user_id (mine = auth.uid(),
--   team = null), not pinned_by. So a designer placing either a
--   mine pin for themselves or a team pin can write any other
--   authenticated user's auth.users.id into pinned_by. Reads are
--   open to all authenticated designers, so the spoofed value is
--   visible. Pin state is not security-critical, but the column
--   exists specifically as audit attribution per the 000155 header
--   ("pinned_by is denormalised audit attribution… we keep both
--   columns even on mine rows so the read path doesn't need to
--   branch on scope to find 'who did this'"), and a spoofable
--   audit column undermines the point of having one.
--
-- Fix:
--   Drop and recreate both insert policies with WITH CHECK clauses
--   that also assert pinned_by = auth.uid(). The dashboard insert
--   path in DashboardPage.tsx already writes pinned_by =
--   currentUser.id on every insert, so this is a tighter contract
--   on the existing happy path, not a behaviour change.
--
-- No change to the SELECT or DELETE policies — neither writes
-- pinned_by, so the spoofing window only ever opens on insert.

begin;

drop policy "proof_pins: mine insert" on proof_pins;

create policy "proof_pins: mine insert"
  on proof_pins for insert
  to authenticated
  with check (
    scope = 'mine'
    and user_id = auth.uid()
    and pinned_by = auth.uid()
  );

drop policy "proof_pins: team insert" on proof_pins;

create policy "proof_pins: team insert"
  on proof_pins for insert
  to authenticated
  with check (
    scope = 'team'
    and user_id is null
    and pinned_by = auth.uid()
  );

commit;
