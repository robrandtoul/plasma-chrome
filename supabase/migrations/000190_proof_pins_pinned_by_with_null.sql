-- Migration 000190: relax the proof_pins INSERT WITH CHECK on
-- pinned_by to match the snooze-table pattern (PV-2026W21-072).
--
-- 000159 tightened the two insert policies so pinned_by = auth.uid()
-- is required on every insert, closing the spoofing surface the
-- 000155 policies left open. 000167 did the same for
-- proof_attention_snoozes' snoozed_by column but with one extra
-- branch: `snoozed_by = auth.uid() OR snoozed_by IS NULL`. That
-- branch is the deliberate escape hatch for future service-role
-- backfills that need to write rows on behalf of no specific
-- designer (FK is ON DELETE SET NULL, so NULL is already an
-- accepted state in the data model).
--
-- proof_pins should follow the same pattern for the same reason:
-- pinned_by FKs auth.users(id) ON DELETE SET NULL (per 000155), so
-- NULL is a legitimate value on existing rows after a designer is
-- deleted. The dashboard insert path always writes auth.uid(), so
-- functionally this commit is a no-op today; it just unblocks a
-- future service-role backfill that wants to write NULL pinned_by
-- without having to re-tighten policies later.
--
-- Drop and recreate both insert policies with the OR-NULL branch.

begin;

drop policy "proof_pins: mine insert" on proof_pins;

create policy "proof_pins: mine insert"
  on proof_pins for insert
  to authenticated
  with check (
    scope = 'mine'
    and user_id = auth.uid()
    and (pinned_by = auth.uid() or pinned_by is null)
  );

drop policy "proof_pins: team insert" on proof_pins;

create policy "proof_pins: team insert"
  on proof_pins for insert
  to authenticated
  with check (
    scope = 'team'
    and user_id is null
    and (pinned_by = auth.uid() or pinned_by is null)
  );

commit;
