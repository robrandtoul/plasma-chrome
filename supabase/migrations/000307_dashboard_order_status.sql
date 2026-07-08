-- 000307_dashboard_order_status.sql
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push` (the CLI link points at the retired standalone
-- project; pushing there would replay ~250 migrations into the stock app).
--
-- Extend the dashboard project rows past "Approved" so the ordering journey is
-- visible at a glance: Approved → Awaiting payment → Ordered.
--
-- Today "Approved" is the last state a project row can show. A proof stays
-- status = 'approved' for its whole ordering life (the order is a separate
-- object on proofs.orders), so the dashboard has no way to tell an approved-but-
-- unordered proof from one that's been paid for. This appends a single derived
-- `order_status` column that collapses the proof's orders into the furthest-
-- along payable state:
--   'ordered'          — at least one order is paid or fulfilled (money in)
--   'awaiting_payment' — a pay link is out and unpaid (status 'sent'), no paid order
--   NULL               — no live payable order
-- draft / expired / cancelled / revision deliberately DON'T count — none of them
-- is a live payable order, so a cancelled-only proof reads plain "Approved" and
-- can still re-trigger the approved_no_order needs-attention rule (whose CTE uses
-- the same sent/paid/fulfilled/revision set). Only ever non-null on approved
-- proofs in the live data, and the row pill (proofBucket) only reads it on
-- approved proofs, so this can never mislabel an in-progress / abandoned proof.
--
-- CREATE OR REPLACE (not drop) — appending a trailing column preserves the
-- grants, the security_invoker = on setting, and the dashboard_list() SETOF
-- dependency (dashboard_list does `select d.*`, so it returns the new column
-- automatically). Same approach as 000246 / 000279. The body below is the exact
-- live definition (verified via pg_get_viewdef 2026-07-07) with only the new
-- order_status column appended after has_open_change_request.

create or replace view proofs.public_dashboard_projects as
 WITH current_versions AS (
         SELECT DISTINCT ON (pv.proof_id) pv.proof_id,
            pv.id AS version_id,
            pv.version_number,
            pv.material_display,
            pv.created_at AS version_created_at,
            pv.created_by AS designer_user_id
           FROM proofs.proof_versions pv
          WHERE pv.is_current
          ORDER BY pv.proof_id, pv.version_number DESC
        ), latest_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_event_at,
            e.event_type AS latest_event_type,
            e.actor_name AS latest_event_actor
           FROM proofs.dashboard_latest_events e
          ORDER BY e.proof_id, e.created_at DESC
        ), latest_non_view_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_non_view_event_at,
            e.event_type AS latest_non_view_event_type
           FROM proofs.dashboard_latest_events e
          WHERE e.event_type <> 'view'::text
          ORDER BY e.proof_id, e.created_at DESC
        ), current_view_state AS (
         SELECT DISTINCT ON (cv_1.proof_id) cv_1.proof_id,
            v.viewed_at AS current_version_viewed_at
           FROM proofs.proof_versions cv_1
             JOIN proofs.proof_version_views v ON v.proof_version_id = cv_1.id
          WHERE cv_1.is_current AND v.is_bot = false
          ORDER BY cv_1.proof_id, v.viewed_at DESC
        ), na AS (
         SELECT proofs_needing_attention.proof_id,
            proofs_needing_attention.rule_code,
            proofs_needing_attention.rule_meta
           FROM proofs.proofs_needing_attention() proofs_needing_attention(proof_id, rule_code, rule_meta)
        ), fu AS (
         SELECT proofs_in_follow_up.proof_id,
            proofs_in_follow_up.rule_code,
            proofs_in_follow_up.sent_count,
            proofs_in_follow_up.max_nudges,
            proofs_in_follow_up.last_sent_at
           FROM proofs.proofs_in_follow_up() proofs_in_follow_up(proof_id, rule_code, sent_count, max_nudges, last_sent_at)
        )
 SELECT p.id AS proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id AS contact_id,
    c.full_name AS contact_name,
    c.email AS contact_email,
    co.id AS company_id,
    co.name AS company_name,
    cv.version_id AS current_version_id,
    cv.version_number AS current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name AS designer_name,
    pr.designer_initials,
    pr.designer_colour,
    pr.avatar_url AS designer_avatar_url,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    snz.snooze_rule_code,
    snz.snoozed_until,
    snz.snooze_note,
    snz.snoozed_by_name,
    snz.snoozed_by_initials,
    snz.snoozed_by_colour,
    lne.latest_non_view_event_at,
    lne.latest_non_view_event_type,
    p.helpscout_last_reply_at,
    p.helpscout_last_customer_reply_at,
    fu.rule_code AS follow_up_rule_code,
    fu.sent_count AS follow_up_sent_count,
    fu.max_nudges AS follow_up_max_nudges,
    fu.last_sent_at AS follow_up_last_sent_at,
    (EXISTS ( SELECT 1
           FROM proofs.proof_name_approvals a
          WHERE a.proof_version_id = cv.version_id AND a.state = 'changes_requested'::text)) AS has_open_change_request,
    -- Furthest-along payable order state for the proof (see header). Drives the
    -- Awaiting payment / Ordered row pills that extend the path past Approved.
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND (o.status = ANY (ARRAY['paid'::text, 'fulfilled'::text])))) THEN 'ordered'::text
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND o.status = 'sent'::text)) THEN 'awaiting_payment'::text
            ELSE NULL::text
        END AS order_status
   FROM proofs.proofs p
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id
     LEFT JOIN current_versions cv ON cv.proof_id = p.id
     LEFT JOIN proofs.profiles pr ON pr.id = cv.designer_user_id
     LEFT JOIN latest_events le ON le.proof_id = p.id
     LEFT JOIN latest_non_view_events lne ON lne.proof_id = p.id
     LEFT JOIN current_view_state cvs ON cvs.proof_id = p.id
     LEFT JOIN na ON na.proof_id = p.id
     LEFT JOIN fu ON fu.proof_id = p.id
     LEFT JOIN LATERAL ( SELECT s.rule_code AS snooze_rule_code,
            s.snoozed_until,
            s.note AS snooze_note,
            pr2.full_name AS snoozed_by_name,
            pr2.designer_initials AS snoozed_by_initials,
            pr2.designer_colour AS snoozed_by_colour
           FROM proofs.proof_attention_snoozes s
             LEFT JOIN proofs.profiles pr2 ON pr2.id = s.snoozed_by
          WHERE s.proof_id = p.id AND s.snoozed_until > (now() - '24:00:00'::interval)
          ORDER BY s.snoozed_until DESC
         LIMIT 1) snz ON true;

-- Defensive re-pin of security_invoker (preserved by CREATE OR REPLACE, but
-- 000186 once dropped it and 000197 had to re-add it — cheap to guarantee here).
alter view proofs.public_dashboard_projects set (security_invoker = on);
