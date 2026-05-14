-- Migration 000179: set security_invoker = on for the 11 public-schema views.
--
-- ── What the Supabase advisor is flagging ────────────────────────────
--
-- The Security Advisor reports 11 CRITICAL "Security Definer View"
-- errors, one for each view in the public schema:
--
--   public_proofs                     public_price_tiers
--   public_proof_versions             public_dashboard_projects
--   public_proof_version_images       material_price_tier_counts
--   public_site_settings              dashboard_latest_events
--   public_material_options           public_proof_version_images
--   public_material_option_surcharges
--   public_material_variants
--
-- By default a Postgres view runs queries with the privileges and RLS
-- context of the role that OWNS the view (here, postgres), not the role
-- that is querying it. The advisor calls this a "security definer view"
-- because it behaves like a SECURITY DEFINER function: it can hand back
-- rows the querying user's own RLS would otherwise filter out.
--
-- ── Why this is low risk for this project, but still worth fixing ────
--
-- The genuinely dangerous exposure here (anonymous visitors enumerating
-- customer data through these views) was already closed in 000162: anon
-- SELECT was revoked on every public_* view and customer reads were
-- routed through the public_get_customer_proof SECURITY DEFINER RPC
-- instead. 000174 re-applied the revoke to public_proof_version_images
-- after 000168 dropped it. So today these 11 views are reachable only by
-- the authenticated (designer) role.
--
-- For the designer role the owner-vs-invoker distinction makes no
-- practical difference: the SELECT RLS policies on the underlying tables
-- (proofs, contacts, companies, proof_versions, ...) are all
-- `to authenticated using (true)` by deliberate design, so a designer
-- already sees every row whether the view runs as the owner or as
-- themselves. Switching to security_invoker therefore does not change
-- which rows any designer can see.
--
-- The anon / customer path is unaffected: public_get_customer_proof
-- reads the underlying tables directly (not these views), so this
-- migration does not touch the customer page at all.
--
-- What we gain is the explicit, advisor-clean declaration: each view now
-- runs with the querying user's RLS, which is the correct posture and
-- closes all 11 errors in one pass.
--
-- ── Why ALTER VIEW ... SET rather than drop + recreate ───────────────
--
-- ALTER VIEW ... SET (security_invoker = on) flips only the option. It
-- does NOT drop the view, does NOT touch column definitions, and does
-- NOT reset grants. That means the 000162 / 000174 anon revokes and the
-- authenticated grants all stay exactly as they are, with no need to
-- re-state them (contrast the drop+recreate trap documented in
-- CLAUDE.md). The statement is naturally idempotent: re-running it on a
-- view that already has the option set is a no-op.

begin;

-- Customer-facing-shaped views (designer-only since 000162).
alter view public_proofs                     set (security_invoker = on);
alter view public_proof_versions             set (security_invoker = on);
alter view public_proof_version_images       set (security_invoker = on);
alter view public_site_settings              set (security_invoker = on);
alter view public_material_options           set (security_invoker = on);
alter view public_material_option_surcharges set (security_invoker = on);
alter view public_material_variants          set (security_invoker = on);
alter view public_price_tiers                set (security_invoker = on);

-- Designer dashboard views.
alter view public_dashboard_projects         set (security_invoker = on);
alter view material_price_tier_counts        set (security_invoker = on);
alter view dashboard_latest_events           set (security_invoker = on);

commit;
