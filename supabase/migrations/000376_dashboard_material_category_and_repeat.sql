-- 000376_dashboard_material_category_and_repeat.sql
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push` (the CLI link points at the retired standalone
-- project; pushing there would replay ~250 migrations into the stock app).
--
-- Two dashboard-row facts the view can answer but currently doesn't, appended
-- in ONE rebuild. They are separate features; they share a migration because
-- they share a view, and rebuilding it twice is how a column added by the first
-- pass gets silently dropped by the second (the 000186 → 000197 footgun, and
-- again in 000363's header).
--
-- ── 1. material_category ─────────────────────────────────────────────────────
--
-- The dashboard's material filter chips classify by REGEX over the material's
-- display name (`metal: /steel|metal|titanium/i`, …). The code comment has been
-- asking for this since it was written — "revisit if a material is added whose
-- name doesn't match one of these patterns" — and the catalogue has carried the
-- answer all along in `materials.category`, which the lead-times chart already
-- keys off. A material named "Onyx" chips as nothing today; after this it chips
-- as metal because that is what it is.
--
-- Reached through the current version, so it is NULL exactly where the row has
-- no material to categorise: a per-direction-pricing Selection stores no
-- version-level material_id at all (000142/000144), which is 4 of the current
-- versions on live today. A NULL category is excluded by every chip except All,
-- which is the same treatment the regex gave a null display name.
--
-- ⚠ It is read through _material_category_map(), NOT a plain join to
-- proofs.materials, and that indirection is load-bearing. This view is
-- security_invoker = on (000181), so a join would run under the READER's RLS —
-- and materials' only SELECT policy is `read non-archived or admin`
-- (archived_at IS NULL OR is_admin()). The moment an admin archives a material
-- that still has live proofs, the join would find nothing for every DESIGNER
-- while continuing to work for every admin: those proofs would silently drop
-- out of the Metal chip, and only for the majority of the team. The old regex
-- read material_display, which is denormalised onto proof_versions and immune
-- to that policy, so this would have been a regression rather than a gap.
-- Same reasoning as 000356, where an RLS-gated join to another schema silently
-- read "not shipped" for every order.
--
-- Nothing sensitive is being exposed: a category is the word "metal", and the
-- reader can already see the material's display name on the same row.
--
-- ── 2. is_repeat / repeat_project_number ─────────────────────────────────────
--
-- "Has this customer bought from us before?" changes how you chase a project,
-- and the row had no way to say so.
--
-- ⚠ The definition is deliberately BROADER than either signal alone, because on
-- live the two barely overlap. Counted 2026-08-02 across all 439 proofs:
--
--     an earlier proof for the same contact ....... 44
--     tagged `repeat customer` in Help Scout ...... 78
--     both ........................................ 12
--     either ..................................... 110
--
-- The 66 tagged proofs with no earlier proof are customers whose first order
-- predates this system — real repeat customers it cannot possibly know about.
-- The 32 with an earlier proof and no tag are ones nobody got round to tagging
-- (the tag sync had a ~64% gap until 000278). Taking either signal on its own
-- would therefore call roughly a third of our repeat customers new. `is_repeat`
-- is the OR of the two.
--
-- `repeat_project_number` is the ordinal ("3rd project") and is deliberately
-- NULL when only the tag says repeat: we know they have been here before, but
-- not how many times, and a made-up "2nd" is worse than no number. The row
-- renders "Repeat customer · 3rd project" when the number is known and a plain
-- "Repeat customer" when it isn't.
--
-- Keyed on contact_id, matching the analytics functions' grain. A colleague at
-- the same company ordering separately reads as new, which is the conservative
-- direction: the marker changes the tone of a chase, and over-claiming
-- familiarity with someone we have not dealt with before is the worse error.
--
-- The `repeat customer` tag is the one Help Scout tag safe to read this way —
-- lifecycle tags (priority 1/2/3, ready to order) are stripped by the approval
-- workflow and mean nothing durable. That rule is baked into 000277 and holds
-- here too.
--
-- ── Shape ────────────────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE (not drop) — appending trailing columns preserves the
-- grants (authenticated + service_role SELECT, anon nothing), the
-- security_invoker = on setting, and the dashboard_list() SETOF dependency
-- (dashboard_list does `select d.*`, so it returns the new columns
-- automatically). Same approach as 000246 / 000279 / 000307. The other three
-- dependents — admin_search_customers, analytics_hot_leads, dashboard_tile_counts
-- — select named columns and are unaffected.
--
-- Body below is the exact live definition (verified via pg_get_viewdef
-- 2026-08-02) with only: material_id added to the current_versions CTE, the new
-- contact_history CTE, the materials left join, and three columns appended
-- after reorder_requested_at.

-- Material id → catalogue category, readable regardless of who is asking. See
-- the note above: the view is security_invoker, and materials' SELECT policy
-- hides archived rows from non-admins, so a direct join would blank the
-- category for designers the moment a material is archived.
--
-- SECURITY DEFINER, and therefore deliberately narrow: two columns, no filter,
-- nothing a designer cannot already see. EXECUTE is revoked from public and
-- anon first — the proofs schema has no pg_default_acl entry for functions, so
-- a new function is born EXECUTE TO PUBLIC and anon holds schema USAGE with
-- PostgREST serving it (the 000356 lesson).
create or replace function proofs._material_category_map()
returns table (material_id uuid, category text)
language sql
stable
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select m.id, m.category from proofs.materials m
$$;

revoke execute on function proofs._material_category_map() from public, anon;
grant execute on function proofs._material_category_map() to authenticated, service_role;

create or replace view proofs.public_dashboard_projects as
 WITH current_versions AS (
         SELECT DISTINCT ON (pv.proof_id) pv.proof_id,
            pv.id AS version_id,
            pv.version_number,
            pv.material_display,
            pv.material_id,
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
        ), contact_history AS (
         -- Where each proof falls in its contact's run of projects: 1 for their
         -- first, 2 for the next, and so on. A running count rather than a
         -- correlated subquery so the whole table is walked once. contact_id is
         -- NOT NULL on every live row, but the filter keeps a future null from
         -- partitioning every unattached proof into one bogus sequence.
         SELECT p2.id AS proof_id,
            (count(*) OVER (PARTITION BY p2.contact_id ORDER BY p2.created_at, p2.id))::integer AS project_number
           FROM proofs.proofs p2
          WHERE p2.contact_id IS NOT NULL
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
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND (o.status = ANY (ARRAY['paid'::text, 'fulfilled'::text])))) THEN 'ordered'::text
            WHEN (EXISTS ( SELECT 1
               FROM proofs.orders o
              WHERE o.proof_id = p.id AND o.status = 'sent'::text)) THEN 'awaiting_payment'::text
            ELSE NULL::text
        END AS order_status,
    p.reorder_of_proof_id,
    p.reorder_requested_at,
    m.category AS material_category,
    (COALESCE(ch.project_number, 1) > 1
       OR COALESCE(p.helpscout_tags @> ARRAY['repeat customer'::text], false)) AS is_repeat,
        CASE
            WHEN COALESCE(ch.project_number, 1) > 1 THEN ch.project_number
            ELSE NULL::integer
        END AS repeat_project_number
   FROM proofs.proofs p
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id
     LEFT JOIN current_versions cv ON cv.proof_id = p.id
     LEFT JOIN proofs._material_category_map() m ON m.material_id = cv.material_id
     LEFT JOIN proofs.profiles pr ON pr.id = cv.designer_user_id
     LEFT JOIN latest_events le ON le.proof_id = p.id
     LEFT JOIN latest_non_view_events lne ON lne.proof_id = p.id
     LEFT JOIN current_view_state cvs ON cvs.proof_id = p.id
     LEFT JOIN na ON na.proof_id = p.id
     LEFT JOIN fu ON fu.proof_id = p.id
     LEFT JOIN contact_history ch ON ch.proof_id = p.id
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

-- Grants and the invoker setting survive CREATE OR REPLACE, but they are
-- restated because a future author reaching for DROP + CREATE (the only way to
-- reorder or remove a column) would otherwise lose them silently — the exact
-- drift 000168 shipped and 000174 spent two months finding. anon is deliberately
-- absent: customer reads go through the SECURITY DEFINER RPC (000162).
alter view proofs.public_dashboard_projects set (security_invoker = on);
revoke select on proofs.public_dashboard_projects from anon, public;
grant select on proofs.public_dashboard_projects to authenticated, service_role;
