-- 000366: seed the "project closed" customer message.
--
-- Abandoning a project has been completely silent since 000022 introduced the
-- status: `handleAbandon` wrote one row and showed the designer a toast, and
-- the only way a customer ever found out was by returning to their own link and
-- reading the "This proof is closed" card. Silence stays the DEFAULT — most
-- abandons are ghosted leads or a designer tidying up, and an unsolicited "we've
-- closed your project" email would do more harm than good — but the designer can
-- now tick a box on the abandon dialog and send this note.
--
-- Sent from the frontend through `send-helpscout-reply` with the rendered body
-- (the same client-render-then-post path SendPayLinkModal / the bundle workspace
-- already use), so there is no new edge function and nothing here is read by a
-- machine. The wording belongs to whoever writes it.
--
-- ⚠ The copy is written to sit alongside the customer-facing closed screen
-- (`AbandonedScreen`, src/pages/CustomerProofPage.tsx), which says only "This
-- proof is closed" and offers a way back in. Four things it must therefore NOT
-- do, each of which the page would contradict:
--   * call the project cancelled / declined / rejected / expired — the page's
--     single word is "closed", and the tone is deliberately non-judgemental;
--   * say the link has stopped working — it still loads, and the visit is still
--     recorded;
--   * invite the customer to "take another look at your designs" there — the
--     artwork is gone from the closed page, so that link is a dead end (which is
--     why there is no {url} variable in this scope at all);
--   * promise we'll follow up — the page's contract is customer-initiated.
-- A "reply to this email" call to action lands back on THIS Help Scout thread;
-- the closed page's own form opens a fresh Customer Support conversation.
--
-- Id is `proof_`-prefixed to match the codebase's own vocabulary for this event
-- (the `proof.abandoned` audit action, the `proof_abandoned` timeline
-- milestone). That prefix normally routes a template into the admin editor's
-- "Post-action confirmations" group with the customer-action variable chips, so
-- AdminTemplatesSection carries an explicit override putting it in its own
-- "Project messages" group with {first_name} / {company} — the same exact-id
-- override `order_cancelled` / `order_revision` already use.
--
-- Same house pattern as 000157/000207/000260/000311/000361: on conflict do
-- nothing so an admin-edited body is never clobbered on replay, and the body is
-- byte-identical to DEFAULT_BODIES in src/lib/replyTemplates.ts so the admin
-- editor's "Reset to default" restores exactly this. No sign-off — Help Scout
-- auto-appends the configured signature.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push` — the CLI link still points at the retired standalone
-- project.

insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'proof_abandoned',
    'Project closed',
    'Optional note sent to the customer when a designer closes a project off (Abandon project). Off by default — abandoning stays silent unless the designer ticks the box. Variables: first_name, company.',
    'Hi {first_name},

We''re closing off your card proof{? company} for {company}{/?} for now, so it''s not left sitting on your list.

Nothing''s lost at our end — if you''d like to pick it back up, just reply to this email and we''ll carry on from where we left off.'
  )
on conflict (id) do nothing;
