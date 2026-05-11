-- Migration 000167: tighten proof_attention_snoozes RLS on the
-- snoozed_by column.
--
-- 000163 shipped an open insert/update/delete policy for
-- proof_attention_snoozes:
--
--   create policy "Authenticated designers manage snoozes"
--     on proof_attention_snoozes for all to authenticated
--     using (true) with check (true);
--
-- Reads are intentionally open (public_dashboard_projects surfaces
-- snoozed_by_name / snoozed_by_initials / snoozed_by_colour to every
-- authenticated designer), but the broad WITH CHECK lets a caller
-- write any other designer's auth.uid() into snoozed_by on a direct
-- upsert against /rest/v1/proof_attention_snoozes. The dashboard
-- Snoozed section then renders the spoofed attribution.
--
-- The DashboardPage.handleSnooze client path already writes
-- snoozed_by = auth.uid() on every upsert, so tightening the policy
-- matches the existing happy path with no behaviour change for
-- legitimate callers.
--
-- Pattern mirrors 000159 (proof_pins_pinned_by_self), which closed
-- the analogous gap on the proof_pins.pinned_by attribution column.
--
-- Policy shape:
--
-- * SELECT — unchanged (open to all authenticated designers).
-- * INSERT — WITH CHECK asserts snoozed_by = auth.uid() OR
--            snoozed_by IS NULL. The IS NULL branch is defensive: the
--            column is nullable (FK ON DELETE SET NULL) so a future
--            backfill or service-role insert could legitimately
--            write NULL.
-- * UPDATE — same WITH CHECK on the proposed row. USING stays open
--            (true) so any designer can extend or change a colleague's
--            snooze; the WITH CHECK then forces the new snoozed_by to
--            be either the caller or NULL.
-- * DELETE — open (true). Matches the team-pin / shared-state pattern:
--            any designer can unsnooze something a colleague snoozed
--            once the issue has been dealt with (per 000163 line 50-53).

begin;

drop policy if exists "Authenticated designers manage snoozes" on proof_attention_snoozes;

create policy "Authenticated designers insert snoozes"
  on proof_attention_snoozes for insert to authenticated
  with check (snoozed_by = auth.uid() or snoozed_by is null);

create policy "Authenticated designers update snoozes"
  on proof_attention_snoozes for update to authenticated
  using (true)
  with check (snoozed_by = auth.uid() or snoozed_by is null);

create policy "Authenticated designers delete snoozes"
  on proof_attention_snoozes for delete to authenticated
  using (true);

commit;
