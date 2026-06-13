-- 000227: record WHICH kind of non-customer email each skipped draft was.
--
-- Until now every non-customer email collapsed to one `skipped` outcome, and
-- the panel labelled the whole bucket "Spam" — wrong, because it lumps genuine
-- supplier mail and automated notifications in with actual spam. This adds a
-- `skip_kind` column the worker fills from the classifier's new
-- non_customer_kind field, so the dashboard can show proper spam (unsolicited
-- junk only) separately from "no reply needed" (suppliers, notifications, etc.)
-- — and so a future spam feature has an honest signal to build on.
--
-- skip_kind is null for everything the drafter actually engaged with
-- (drafted / abstained / blocked); set only on skipped rows.

alter table proofs.ai_drafts
  add column if not exists skip_kind text
  check (skip_kind is null or skip_kind in
    ('genuine', 'spam', 'supplier', 'automated_notification', 'other'));

-- Safe deterministic backfill: the notification pre-filter is rule-based, so
-- its rows are provably automated notifications. Everything else stays null —
-- we cannot tell spam from supplier on old rows after the fact, and the whole
-- point is that nothing is recorded as spam unless it truly was. New rows get
-- an accurate kind from the classifier going forward.
update proofs.ai_drafts
  set skip_kind = 'automated_notification'
  where skip_kind is null
    and lower(coalesce(abstain_or_block_reason, '')) like '%automated notification%';

-- No grant changes: skip_kind inherits the table's existing grants
-- (authenticated SELECT, service_role all; anon never had ai_drafts).
