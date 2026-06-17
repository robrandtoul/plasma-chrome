-- Migration 000242: dashboard_latest_events — use the LATEST view of the day
--
-- Background. `dashboard_latest_events` synthesises a 'view' event row per
-- (proof_version, day) from proof_version_views (migration 000127). The
-- DISTINCT ON dedupe ordered by `viewed_at` ascending, so the surviving row
-- carried the timestamp of the *first* time the proof was opened that day.
--
-- That timestamp flows up into `public_dashboard_projects.latest_event_at`,
-- which the dashboard uses for three things: the "Activity" sort order, the
-- per-row "Viewed Xm ago" label (000306-era), and the right-hand "Latest
-- activity" card. Meanwhile the Today / This week / Older grouping keys off
-- `proofs.last_activity_at`, which is bumped on *every* non-bot view (000081)
-- — i.e. the *most recent* view.
--
-- So a proof opened twice in a day had two different "recency" clocks: the
-- sort/label/card read the first open, the grouping read the latest. A proof
-- genuinely viewed minutes ago could therefore sort and group as if its last
-- activity were hours earlier (the Willis case). Flipping the dedupe to keep
-- the *latest* view of the day makes `latest_event_at` agree with
-- `last_activity_at`, so all four surfaces read one genuinely-most-recent
-- clock. The frontend grouping change in the same PR keys the buckets off the
-- same field as the sort to close the remaining seam.
--
-- Only the inner view subquery's ORDER BY direction changes (... viewed_at
-- DESC). The output column list is byte-for-byte identical, so CREATE OR
-- REPLACE VIEW is valid — it preserves the existing grants
-- (authenticated/service_role SELECT) and the security_invoker = on option
-- without a drop, avoiding the grant-wipe footgun.
--
-- The proof_events half of the UNION is untouched, so latest_non_view_event_*
-- (the Changes-requested tile) and the needs-attention rules — which read the
-- event tables directly, not this view — are unaffected.

begin;

create or replace view proofs.dashboard_latest_events as
 SELECT e.id,
    e.created_at,
    e.event_type,
    e.actor_name,
    e.name AS recipient_name,
    e.helpscout_thread_id,
    pv.id AS proof_version_id,
    pv.version_number,
    p.id AS proof_id,
    c.full_name AS contact_name,
    co.name AS company_name
   FROM proofs.proof_events e
     JOIN proofs.proof_versions pv ON pv.id = e.proof_version_id
     JOIN proofs.proofs p ON p.id = pv.proof_id
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id
UNION ALL
 SELECT v.id,
    v.viewed_at AS created_at,
    'view'::text AS event_type,
    COALESCE(c.full_name, 'Customer'::text) AS actor_name,
    NULL::text AS recipient_name,
    NULL::text AS helpscout_thread_id,
    pv.id AS proof_version_id,
    pv.version_number,
    p.id AS proof_id,
    c.full_name AS contact_name,
    co.name AS company_name
   FROM ( SELECT DISTINCT ON (proof_version_views.proof_version_id, (date_trunc('day'::text, proof_version_views.viewed_at))) proof_version_views.id,
            proof_version_views.proof_version_id,
            proof_version_views.viewed_at
           FROM proofs.proof_version_views
          WHERE proof_version_views.is_bot = false
          ORDER BY proof_version_views.proof_version_id, (date_trunc('day'::text, proof_version_views.viewed_at)), proof_version_views.viewed_at DESC) v
     JOIN proofs.proof_versions pv ON pv.id = v.proof_version_id
     JOIN proofs.proofs p ON p.id = pv.proof_id
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id;

commit;
