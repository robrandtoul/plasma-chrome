-- Migration 000160: redefine business_days_between as inclusive
-- at the end (counts d2, excludes d1).
--
-- Why
--   The original 000154 version was strictly between (neither
--   endpoint counted). So Mon → Fri returned 3, not 4. Combined
--   with rules that fire when "days >= threshold_days", this meant
--   the seeded thresholds in needs_attention_rules fired two
--   inclusive working days later than the chip copy implied:
--
--     request_changes_no_version  threshold 2 → fires after 4
--     sent_never_viewed           threshold 3 → fires after 5
--     viewed_not_actioned         threshold 5 → fires after 7
--     stuck_in_progress           threshold 10 → fires after 12
--
--   approaching_dormant uses calendar-day epoch arithmetic in
--   proofs_needing_attention(), so it isn't affected.
--
--   The chip copy on the dashboard reads "Sent N working days
--   ago" / "Last action N working days ago" — the human reading
--   of which is "elapsed working days since the event", inclusive
--   of today. Inclusive-at-end is the correction that makes the
--   thresholds and the copy agree without bumping every seed.
--
-- What
--   Range becomes (d1, d2] instead of (d1, d2):
--     least(d1, d2) + 1  (exclusive lower — don't count the day
--                         the event happened)
--     greatest(d1, d2)    (inclusive upper — count the calling day
--                         if it's a weekday)
--   Same-day still returns 0 (empty series).
--
--   Threshold seeds are NOT changed — the helper change alone
--   makes the seeded numbers fire on the day the chip copy says
--   they will.

begin;

create or replace function business_days_between(d1 date, d2 date)
returns int
language sql
immutable
as $$
  -- Inclusive at end: counts the upper endpoint (the calling day,
  -- when used as business_days_between(event_date, now())) and
  -- excludes the lower (the day the event happened, since zero
  -- working days have elapsed at that moment). Mon → Fri returns
  -- 4 (Tue, Wed, Thu, Fri). Same day returns 0 (empty range).
  -- Reverse-order args symmetrise via least / greatest.
  select coalesce(count(*), 0)::int
  from generate_series(
    least(d1, d2) + 1,
    greatest(d1, d2),
    interval '1 day'
  ) g(d)
  where extract(dow from d) not in (0, 6);
$$;

comment on function business_days_between(date, date) is
  'Counts weekdays (Mon–Fri) inclusive at the upper endpoint and '
  'exclusive at the lower. Mon → Fri = 4. Same day = 0. Bank '
  'holidays are not honoured — out of scope for Phase 2a. Used '
  'by proofs_needing_attention() for any rule with calendar=false.';

commit;
