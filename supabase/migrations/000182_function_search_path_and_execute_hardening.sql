-- Migration 000182: Security Advisor remediation, the safely-fixable subset.
--
-- The Supabase Security Advisor reports 95 WARN-level findings across
-- seven lint types. This migration addresses the two that are a safe,
-- mechanical fix with no behaviour change. The rest are deliberate
-- design decisions, dashboard settings, or judgement calls, and are
-- written up for Rob separately rather than changed here.
--
-- ── Part 1: pin search_path on the 27 flagged functions ──────────────
--
-- Lint: "Function Search Path Mutable" (27 findings).
--
-- A Postgres function with no search_path setting resolves unqualified
-- object names against whatever search_path the caller happens to have.
-- That is a latent injection vector: a caller could put a lookalike
-- object earlier in their path and have the function read it instead.
-- The fix is to pin each function to a fixed search_path.
--
-- All 27 flagged functions are plain SECURITY INVOKER functions (every
-- SECURITY DEFINER function in the database already pins search_path).
-- The 27 are:
--   apply_core_colours_import, bump_proof_activity, business_days_between,
--   clear_supersession_on_delete, contacts_flag_test_fixture,
--   dashboard_tile_counts, delete_company_if_empty, delete_contact_if_empty,
--   delete_proof_cascade, mark_dormant_proofs, prevent_last_admin_demotion,
--   prevent_pricing_snapshot_update, proof_events_validate_material_option_code,
--   proof_name_approvals_validate_material_option_code, proofs_needing_attention,
--   reopen_proof, set_designer_presentation, set_is_current_on_insert,
--   set_letterpress_core_colour_updated_at, set_version_number,
--   snapshot_split_name_surcharge, stamp_supersession_on_insert,
--   sync_material_display_name, unset_sibling_is_current, update_updated_at,
--   validate_variant_round_image, validate_variant_round_proof_version.
--
-- We pin to `public` rather than the empty string. The empty-string
-- option is stricter but would require rewriting every function body to
-- schema-qualify each table name, which is a large, error-prone change
-- on working code. Pinning to `public` removes the implicitly-searched
-- pg_temp from the path (closing the injection vector) while leaving the
-- existing unqualified `public` references resolving exactly as before.
-- pg_catalog is still searched implicitly, so built-ins like now() and
-- coalesce() are unaffected.
--
-- This is done as a loop over pg_proc rather than 27 hand-written ALTER
-- statements: it cannot get a signature wrong, cannot miss one, and is
-- idempotent (the WHERE clause skips any function that already has a
-- search_path, so a re-run is a no-op). It only ever touches functions
-- that genuinely lack the setting.
--
-- ── Part 2: lock EXECUTE on internal-only SECURITY DEFINER functions ─
--
-- Lint: "Public Can Execute SECURITY DEFINER Function" +
--       "Signed-In Users Can Execute SECURITY DEFINER Function"
--       (the 11 functions below account for 22 of those findings).
--
-- The advisor flags every SECURITY DEFINER function that anon or
-- authenticated can call. For this database that list is 21 functions,
-- and most of them are deliberately callable: public_get_customer_proof,
-- public_get_lead_times, public_settings and record_proof_view are the
-- anon customer-page surface, and admin_list_users, apply_pricing_updates,
-- is_admin, log_audit_event and log_designer_override_event are the
-- authenticated designer/admin surface. Revoking EXECUTE on those would
-- break the app, so they are deliberately left alone.
--
-- The 11 functions below are different: they are trigger functions and
-- internal plumbing that nothing calls directly. Triggers invoke their
-- function regardless of the caller's EXECUTE privilege, so revoking it
-- changes nothing about how the triggers fire; it just removes these
-- functions from the callable API surface, which is the correct posture
-- and clears the finding. A grep of src/ and supabase/functions/ found
-- no .rpc() call to any of them (the only references are code comments).

begin;

-- ── Part 1 ───────────────────────────────────────────────────────────
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
        where cfg like 'search_path=%'
      )
  loop
    execute format('alter function %s set search_path = public', fn.sig);
  end loop;
end;
$$;

-- ── Part 2 ───────────────────────────────────────────────────────────
-- Trigger functions (fired by triggers, never called directly).
revoke execute on function bump_activity_on_approval()                 from public, anon, authenticated;
revoke execute on function bump_activity_on_image()                    from public, anon, authenticated;
revoke execute on function bump_activity_on_view()                     from public, anon, authenticated;
revoke execute on function handle_new_user()                           from public, anon, authenticated;
revoke execute on function maybe_finalize_proof_status()               from public, anon, authenticated;
revoke execute on function reconcile_name_approvals_on_names_change()   from public, anon, authenticated;
revoke execute on function reconcile_shared_approval_on_images_change() from public, anon, authenticated;
revoke execute on function wake_proof_on_activity()                    from public, anon, authenticated;

-- Internal helpers / cron functions (no external callers).
--   _finalize_proof_if_complete  - called only by the finalize triggers
--   bump_proof_activity_by_version - internal activity helper, no .rpc() callers
--   auto_dormant_stale_proofs    - invoked by the pg_cron dormancy job
revoke execute on function _finalize_proof_if_complete(uuid)           from public, anon, authenticated;
revoke execute on function bump_proof_activity_by_version(uuid)        from public, anon, authenticated;
revoke execute on function auto_dormant_stale_proofs()                 from public, anon, authenticated;

commit;
