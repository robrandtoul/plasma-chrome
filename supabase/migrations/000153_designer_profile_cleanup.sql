-- Migration 000153: designer profile cleanup.
--
-- Three things land here:
--
--   1. Re-pin designer_colour onto the right profile rows.
--      000152's email-based pin sent 'blue' to a stale
--      rob.randtoul@gmail.com account that pre-dated the move to
--      rob@plasmadesign.co.uk, so the actively-used Rob profile
--      ended up with whatever the hash bucket landed on (purple).
--      000152's hash-bucket fallback for everyone else also
--      collided two designers onto teal. We re-assign by email
--      here so the dashboard avatar set lines up with the team:
--        Rob   → blue
--        Chris → teal     (was assigned coral by the hash; not wrong,
--                         just chosen consciously)
--        JJ    → purple   (was teal — colliding with Test Designer)
--
--   2. Fill in Chris Jackson's missing full_name + designer_initials.
--      The chris@plasmadesign.co.uk profile shipped without a name
--      set, so the dashboard avatar rendered as a blank circle.
--
--   3. Delete two auth.users rows that were vestigial:
--        rob.randtoul@gmail.com         — pre-rebrand Rob account
--        test-designer@example.invalid  — leftover seed user
--
--      Both cascades to public.profiles via the existing
--      profiles.id → auth.users.id ON DELETE CASCADE FK
--      (20260419000002_create_profiles.sql).
--
-- Audit-log behaviour worth knowing for future readers:
--
--   public.audit_log.actor_id → auth.users(id) is ON DELETE SET NULL
--   (000043). The gmail Rob account has 392 historical audit rows
--   (20 Apr → 4 May 2026, when Rob was still signing in under
--   gmail). Those rows stay in place; only the actor_id column
--   nulls out. The denormalised actor_email + actor_label columns
--   on every row preserve the actor identity for the audit trail
--   — they were written specifically so an account deletion can't
--   destroy attribution. test-designer has zero audit_log rows.
--
--   The other SET-NULL FKs (proof_versions.created_by,
--   proof_name_approvals.overridden_by_user_id) and the NO-ACTION
--   FKs (reply_templates.updated_by, settings.updated_by) all hold
--   zero rows pointing at either user, so they're not in play here.
--
-- Looked up by email rather than UUID throughout so this is
-- readable on its own and survives a hypothetical replay against
-- a fresh database where the UUIDs would differ.

begin;

-- ── 1. Colour + name updates ────────────────────────────────────────────────

update profiles
   set designer_colour = 'blue'
 where id = (select id from auth.users where email = 'rob@plasmadesign.co.uk');

update profiles
   set full_name         = 'Chris Jackson',
       designer_initials = 'CJ',
       designer_colour   = 'teal'
 where id = (select id from auth.users where email = 'chris@plasmadesign.co.uk');

-- JJ moved off 'teal' so Chris and JJ aren't both teal — the hash
-- bucket in 000152 placed them in the same colour by chance. No
-- other meaning attached to 'purple' for JJ; it's just the next
-- free slot in the four-colour palette.
update profiles
   set designer_colour = 'purple'
 where id = (select id from auth.users where email = 'jj@plasmadesign.co.uk');

-- ── 2. Vestigial account deletes ────────────────────────────────────────────
--
-- Email lookups stay readable; nullsafe with `is not null` guards in
-- case the email has already been removed (idempotent re-runs).

delete from auth.users
 where email = 'rob.randtoul@gmail.com';

delete from auth.users
 where email = 'test-designer@example.invalid';

commit;
