-- 000403: "said yes" is not "ordered again".
--
-- The desk converted a prospect on proof status alone — planDesk put a row in
-- toConvert on `facts?.status === 'approved'`, and syncProspectOutcomes wrote
-- state='converted', which the register renders as "Ordered again" in green and
-- counts as the campaign's headline conversion. So one press of Approve, or a
-- designer's "Mark as approved", booked a sale that did not exist and dropped
-- the customer out of every follow-up, quiet-close and reply bucket for good.
--
-- The band now withholds Approve on an outreach v1 (see
-- suppressApproveForOutreach), which removes the customer's route — but not the
-- designer's, and the register is the record the whole 2,739-name campaign will
-- be judged by. So the desk moves onto a PAID production order instead.
--
-- That leaves a real gap between the two: a customer who has approved and is
-- waiting for a pay link. They must not be left in 'contacted' — the tail of
-- that branch would send them a "still thinking?" follow-up after they have
-- already said yes, and then quietly close them, which is worse than the bug
-- being fixed. Hence a state of their own rather than a plan bucket.
--
-- CHECK only — no new column, no data change. Every existing row already
-- satisfies it (live carries pending / suppressed / queued only).
--
-- ⚠ Apply this BEFORE deploying the frontend. syncProspectOutcomes writes
-- 'accepted' on every desk load, and against an unmigrated database each of
-- those writes fails the CHECK — silently, since they are fire-and-forget.
--
-- Verified inert against the nightly reconcile: reconcile_reorder_register()
-- resets state only `when rp.state in ('pending','queued','closed_no_response')`,
-- so an 'accepted' row survives reconciliation untouched.
--
-- ⚠ Expect the register's "Ordered again" figure to FALL once this ships. That
-- is not a regression — it is the old number being wrong, because it counted
-- approvals (including designer overrides) as sales.

alter table proofs.reorder_prospects
  drop constraint reorder_prospects_state_check;

alter table proofs.reorder_prospects
  add constraint reorder_prospects_state_check
  check (state = any (array[
    'pending', 'queued', 'in_build', 'contacted', 'replied',
    'accepted',            -- 000403: approved, no paid order yet
    'converted', 'declined', 'closed_no_response', 'suppressed'
  ]));
