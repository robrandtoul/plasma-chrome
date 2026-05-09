-- Migration 000156: capture the live profiles.helpscout_user_id values
-- in source.
--
-- The column was added in 000123 and is already populated in the
-- linked Supabase project — the values were set over time via the
-- admin-set-helpscout-user-id edge function (the "Manage users" page
-- in the admin UI), and have been driving per-designer attribution on
-- send-helpscout-reply since that function shipped. They live in the
-- live DB but not in source, so a fresh-replay (local dev reset,
-- staging restore, etc.) would have them all NULL and every staff
-- reply would silently fall back to HELPSCOUT_DEFAULT_USER_ID.
--
-- This migration captures the live values into the migration set so
-- the source-of-truth and the linked project agree, following the
-- same pattern as 000153's designer_colour reconciliation.
--
-- Idempotent: each UPDATE is gated by `helpscout_user_id IS DISTINCT
-- FROM <expected>`, so a re-run on a DB already in sync matches zero
-- rows. Mirrors the loose-LIKE pattern in 000149/000150.
--
-- Coupled to the proof-action confirmation reply work: that change
-- relies on profiles.helpscout_user_id being non-null on the proof's
-- assigned designer to attribute the customer-facing confirmation
-- reply correctly. The HS conversation assignee is the second-tier
-- fallback, but having every active designer mapped here makes the
-- first-tier path the dominant one.

begin;

-- Chris Jackson
update profiles set helpscout_user_id = 93267
  where id = '9cd58440-ba54-4f3d-aec9-98d1f18795c8'
    and helpscout_user_id is distinct from 93267;

-- Donna Lambe
update profiles set helpscout_user_id = 59454
  where id = '0ecb7056-6358-4243-8b05-c87df4525eec'
    and helpscout_user_id is distinct from 59454;

-- Jack Johnson
update profiles set helpscout_user_id = 66150
  where id = '2cf143ad-bd49-4b90-a25b-793b0f301511'
    and helpscout_user_id is distinct from 66150;

-- Rob Randtoul
update profiles set helpscout_user_id = 52245
  where id = '59205cfa-c2fc-4113-b923-c705655e0ea2'
    and helpscout_user_id is distinct from 52245;

commit;
