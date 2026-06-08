-- 000213_dashboard_customer_responded_count.sql
--
-- Fold the dashboard's "Changes requested" stat tile into a broader
-- "Customer responded" tile that ALSO counts proofs where the customer
-- responded by replying on the linked Help Scout conversation (the
-- helpscout_last_customer_reply_at stamp from migration 000208) instead
-- of using the in-app sidebar.
--
-- Why: a customer who replies to the proof email is, in practice,
-- responding to the proof — but proof-viewer only ever treated the
-- sidebar change-request path as an actionable headline signal. The
-- email reply previously just suppressed the chase rules and showed a
-- muted "Customer replied Nd ago" chip, so it was easy to miss. This
-- combines both response paths into one count so neither slips past the
-- designer. The per-row chips stay distinct ("Changes requested" vs
-- "Replied by email" — see proofBucket in src/lib/dashboardGrouping.ts);
-- only the headline tile COUNT is combined here.
--
-- This is the only change vs 000202: the `changes_requested` JSON key is
-- replaced by `customer_responded`, whose predicate is the old
-- changes-requested test OR a "replied by email and we haven't responded
-- since" test. The other five counts are byte-for-byte 000202.
--
-- "Replied by email" predicate (mirrors isCustomerReplied in
-- dashboardGrouping.ts, kept in exact lockstep with the tile's
-- click-through filter):
--   * the customer's last Help Scout reply is newer than our last reply
--     (coalesce the staff reply to epoch so a thread we never replied to
--     still counts), AND
--   * newer than the current version's upload (so a reply already
--     answered by a fresh version doesn't linger; a null version date
--     can't gate it out).
-- Both response predicates sit under the same gate as the old tile: no
-- needs-attention rule, not currently snoozed, status in_progress. (A
-- proof matching BOTH sub-predicates is counted once — the OR dedups.)
--
-- SECURITY INVOKER + grants restated, identical to 000202.

begin;

create or replace function dashboard_tile_counts()
returns json
language sql
security invoker
set search_path = public
as $$
  with p as (
    select
      d.*,
      exists (
        select 1 from proof_attention_snoozes s
        where s.proof_id = d.proof_id and s.snoozed_until > now()
      ) as snoozed
    from public_dashboard_projects d
  )
  select json_build_object(
    'needs_attention', (
      select count(*) from p
      where rule_code is not null and not snoozed
    ),
    'not_viewed', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status in ('in_progress', 'dormant')
        and current_version_id is not null
        and current_version_viewed_at is null
    ),
    'awaiting_customer', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status = 'in_progress'
        and current_version_id is not null
        and current_version_viewed_at is not null
    ),
    'customer_responded', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status = 'in_progress'
        and (
          -- Sidebar change request, newer than the current version.
          (
            latest_non_view_event_type = 'request_changes'
            and latest_non_view_event_at is not null
            and version_created_at is not null
            and latest_non_view_event_at > version_created_at
          )
          -- Replied by email on the linked Help Scout conversation, and
          -- we haven't replied / shipped a new version since.
          or (
            helpscout_last_customer_reply_at is not null
            and helpscout_last_customer_reply_at > coalesce(helpscout_last_reply_at, 'epoch'::timestamptz)
            and (version_created_at is null or helpscout_last_customer_reply_at > version_created_at)
          )
        )
    ),
    'dormant', (
      select count(*) from p
      where not snoozed and status = 'dormant'
    ),
    'approved_this_week', (
      select count(*) from p
      where not snoozed
        and status = 'approved'
        and approved_at is not null
        and approved_at >= now() - interval '7 days'
    )
  );
$$;

revoke execute on function dashboard_tile_counts() from anon, public;
grant execute on function dashboard_tile_counts() to authenticated;

commit;
