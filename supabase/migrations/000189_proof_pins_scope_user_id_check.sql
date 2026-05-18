-- Migration 000189: document that proof_pins already carries an
-- explicit scope/user_id invariant (PV-2026W21-048).
--
-- The 2026-05-19 audit listed this finding on the basis that the
-- (scope, user_id) coupling was only enforced implicitly through the
-- two partial unique indexes from 000155 (proof_pins_mine_unique on
-- (proof_id, user_id) WHERE scope='mine', and proof_pins_team_unique
-- on (proof_id) WHERE scope='team'). Re-reading the original
-- migration shows that 000155 also added an explicit table-level
-- CHECK constraint, proof_pins_scope_user_check, with the exact
-- predicate the audit asked for:
--
--   (scope = 'mine' and user_id is not null) or
--   (scope = 'team' and user_id is null)
--
-- So the invariant is already explicit at the table level. Rather
-- than add a redundant duplicate under a different name, this
-- migration adds a comment on the existing constraint so a future
-- reader (or a re-audit) can see at a glance that the invariant is
-- already in place and which finding it relates to.

begin;

comment on constraint proof_pins_scope_user_check on proof_pins is
  'Enforces the scope/user_id invariant: mine pins must reference a '
  'designer; team pins must not. Originally added inline in 000155 '
  'alongside the partial unique indexes. Documented here in 000189 '
  'after PV-2026W21-048 flagged the invariant as implicit.';

commit;
