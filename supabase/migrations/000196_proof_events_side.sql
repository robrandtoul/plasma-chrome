-- Migration 000196: record the card side a change request was about.
--
-- Phase 3 of the customer-page action rework. The customer-facing
-- detail view (000124 onwards in product time, Phase 2 of the
-- rework) shows one side of the card enlarged with front/back
-- chevron navigation. When the customer sends a change request
-- with the detail view open, we record which side was visible at
-- that moment so the designer reading the audit log can see
-- exactly what the customer was looking at — "Move the logo down
-- on the back" is much easier to act on when the audit row
-- already tells you side=back.
--
-- Nullable on purpose: a change request submitted with the
-- detail view closed (i.e. opened from the per-recipient action
-- band on the overview, without zooming into a specific side
-- first) genuinely has no single side context. The customer
-- might be commenting on both sides, or on the spec rather than
-- the artwork. Null is the right value there — this is a
-- designer-facing hint, not a required field.
--
-- Designer-only surface: no public_* view changes, no anon RPC
-- changes, no grant work. proof_events is already SELECT-granted
-- to authenticated (000176), and dashboard_latest_events selects
-- explicit columns so adding a new column doesn't change its
-- shape. The customer page's display of change requests is
-- untouched — side stays on the designer side.
--
-- No backfill. Every existing proof_events row predates the
-- detail view shipping, so null is the correct value for them
-- (we have no signal about which side was visible — there wasn't
-- a side concept on the customer page at the time).
--
-- CHECK matches the 'front' | 'back' enum from
-- proof_version_images.side (000071); deliberately reuses the
-- same vocabulary so cross-references read naturally and a
-- future join doesn't have to coerce.

begin;

alter table proof_events
  add column side text null
    check (side in ('front', 'back'));

comment on column proof_events.side is
  'Card side the customer had open in the detail view at the moment '
  'they submitted this event. Null when no detail view was open or '
  'when the event predates the Phase 3 customer-page rework. Only '
  'change_request events carry meaningful values today; approvals '
  'and other event types currently leave it null.';

commit;
