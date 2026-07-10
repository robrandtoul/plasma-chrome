-- 000312_bundle_update_template.sql
-- Bundle orders Slice 3 follow-up — the "Send update" message template.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- The bundle membership lock is relaxed (Rob, 10 Jul): a card CAN be added
-- to an already-sent bundle, behind a mandatory "Send update to customer"
-- step on the bundle workspace — the customer keeps the ONE link, and gets
-- told about the new card. This seeds the message that step composes from.
-- Same house pattern as 000157/000207/000311's seed: ON CONFLICT DO NOTHING
-- so an admin-edited body is never clobbered; the default body mirrors
-- DEFAULT_BODIES in src/lib/replyTemplates.ts. No sign-off (Help Scout
-- appends the signature). Id not proof_/nudge_/order_-prefixed → renders in
-- the designer-composed pre-send group of Admin → Templates, with the
-- designer_picked variable chips ({first_name}/{company}/{url}).
insert into proofs.reply_templates (id, display_name, description, body)
values (
  'bundle_update_link',
  'Bundle update',
  'Sent from the bundle workspace when a card is added to an already-sent bundle. {url} is the same bundle review link the customer already has.',
  'Hi {first_name},

We''ve added another card to your review page{? company} for {company}{/?} — same link as before, with the new design ready to look over alongside the others:

{url}'
)
on conflict (id) do nothing;
