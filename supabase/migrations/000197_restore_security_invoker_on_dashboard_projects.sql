-- Migration 000197: restore security_invoker = on on public_dashboard_projects.
--
-- Migration 000181 set security_invoker = on on all 11 public-schema
-- views as part of the security-advisor cleanup, so each view runs
-- with the querying user's RLS context rather than the owner's.
--
-- Migration 000186 then dropped and recreated public_dashboard_projects
-- to widen the snooze lateral to a 24-hour grace window. A
-- dropped-and-recreated view defaults to security_invoker = off, and
-- 000186 restated the REVOKE and the GRANT but not the
-- security_invoker option, so the view silently reverted to
-- owner-context. (000192 got this right for public_proof_version_images
-- after its own drop+recreate; 000186 is the gap this migration closes.)
--
-- This migration re-pins the option. Option-only ALTER: no drop,
-- no grant changes, no behaviour change for the authenticated role
-- (every underlying SELECT policy is `to authenticated using (true)`),
-- it simply restores the advisor-clean declaration 000181 established.

begin;

alter view public_dashboard_projects set (security_invoker = on);

commit;
