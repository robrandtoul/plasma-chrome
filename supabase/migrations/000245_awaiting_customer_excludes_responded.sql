-- 000245_awaiting_customer_excludes_responded.sql
--
-- Make the "Awaiting customer" tile mutually exclusive with the
-- "Customer responded" tile, so the count and its click-through list stop
-- including proofs the customer has actually responded to.
--
-- The bug: the awaiting_customer predicate was just "in_progress, no rule,
-- current version viewed". A proof where the customer viewed the current
-- version and THEN requested changes (sidebar) or replied by email
-- satisfies that predicate too, so it was double-counted in both
-- awaiting_customer and customer_responded, and showed in both
-- click-through lists. The row pills already resolve this via
-- proofBucket()'s precedence (changes_requested / customer_replied rank
-- above awaiting_customer in src/lib/dashboardGrouping.ts); the tile
-- predicates just hadn't followed suit.
--
-- Fix: subtract the customer_responded sub-predicates from
-- awaiting_customer. The excluded expression is byte-for-byte the OR used
-- by the customer_responded count (the change-request half + the
-- replied-by-email half), so the two tiles partition cleanly: a responded
-- proof now counts only under customer_responded, and "Awaiting customer"
-- means "viewed, no response yet" — matching its pill.
--
-- Only the awaiting_customer count changes; the other five are byte-for-byte
-- 000213. The matching client-side click-through filter is updated in
-- src/pages/DashboardPage.tsx in the same change.
--
-- Schema-qualified for the merged stock-control project's `proofs` schema.
-- SECURITY INVOKER + grants restated, matching the live sibling.

begin;

create or replace function proofs.dashboard_tile_counts()
returns json
language sql
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  with p as (
    select
      d.*,
      exists (
        select 1 from proofs.proof_attention_snoozes s
        where s.proof_id = d.proof_id and s.snoozed_until > now()
      ) as snoozed
    from proofs.public_dashboard_projects d
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
        -- Exclude proofs the customer has already responded to: those
        -- belong to the customer_responded tile, not here. This is the
        -- same OR used by the customer_responded count below.
        and not (
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

revoke execute on function proofs.dashboard_tile_counts() from anon, public;
grant execute on function proofs.dashboard_tile_counts() to authenticated;

commit;
