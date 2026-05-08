-- Migration 000150: strip the trailing sign-off from reply_templates
-- without requiring exact match on the rest of the body.
--
-- Bug audit PV-2026W19-001 follow-up. Migration 000149 used a strict
-- body equality check to spare admin-edited rows, but the live rows
-- had drifted (apostrophe characters mangled) so 000149 matched zero
-- rows and the customer-visible double sign-off persisted. This
-- migration matches by id + LIKE pattern, strips only the trailing
-- sign-off block, leaves the rest of the body untouched. Any
-- apostrophe drift or other admin edits stay in place for human
-- review through the admin UI afterwards.
--
-- Idempotent: re-running on already-fixed rows matches zero.

begin;

update reply_templates
set body = regexp_replace(body, E'\\n\\nMany thanks,\\nPlasma Design\\s*$', '')
where id in ('first_proof', 'revision')
  and body like E'%Many thanks,%Plasma Design%';

commit;
