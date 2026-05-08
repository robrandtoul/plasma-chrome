-- Migration 000149: drop the sign-off from the seeded reply
-- templates so Help Scout's auto-appended signature is the only
-- sign-off the customer sees.
--
-- Bug audit PV-2026W19-001 surfaced this: the seed in 000102 ended
-- with "Many thanks,\nPlasma Design", and Help Scout appends a
-- pre-defined signature on top. Customers got two sign-offs every
-- time a designer used the seeded body. The change here updates
-- the live rows only when they still match the original seed,
-- so admin-edited bodies are left alone.
--
-- Idempotent: re-running on an already-fixed DB matches zero rows.

begin;

update reply_templates
set body = E'Hi {first_name},\n\nHere''s the first proof of your cards{? company} for {company}{/?}. Have a look and let us know what you think.\n\n{url}'
where id = 'first_proof'
  and body = E'Hi {first_name},\n\nHere''s the first proof of your cards{? company} for {company}{/?}. Have a look and let us know what you think.\n\n{url}\n\nMany thanks,\nPlasma Design';

update reply_templates
set body = E'Hi {first_name},\n\nHere''s v{version_number} of your cards{? company} for {company}{/?} with the changes you asked for. Take another look when you have a moment.\n\n{url}'
where id = 'revision'
  and body = E'Hi {first_name},\n\nHere''s v{version_number} of your cards{? company} for {company}{/?} with the changes you asked for. Take another look when you have a moment.\n\n{url}\n\nMany thanks,\nPlasma Design';

commit;
