-- 000386_bundle_revision_template.sql
-- The bundle revision-round message template.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- A revision round on a bundle (the Experience Auto Group shape: one change
-- request touching all three cards) used to end with the per-card send panel
-- after every save — an email per card, all carrying the same bundle link,
-- the first arriving while sibling cards were still un-revised. The fix
-- routes the round to the bundle workspace's ONE update send; this seeds the
-- message that send composes when the unannounced cards include revisions
-- (any past v1), where 000312's "we've added another card" body would
-- misdescribe what happened. The workspace picks between the two by version
-- number; both fall back to code defaults if the row is missing, so deploy
-- order is free.
--
-- Same house pattern as 000157/000311/000312: ON CONFLICT DO NOTHING so an
-- admin-edited body is never clobbered; the default body mirrors
-- DEFAULT_BODIES in src/lib/replyTemplates.ts (byte-identity pinned by
-- `pnpm test:bundle-checkpoint`). No sign-off (Help Scout appends the
-- signature). Id not proof_/nudge_/order_-prefixed → renders in the
-- designer-composed pre-send group of Admin → Templates, with the
-- designer_picked variable chips ({first_name}/{company}/{url}).
insert into proofs.reply_templates (id, display_name, description, body)
values (
  'bundle_revision_link',
  'Bundle revision',
  'Sent from the bundle workspace when cards in an already-sent bundle have been revised. {url} is the same bundle review link the customer already has.',
  'Hi {first_name},

We''ve updated the designs on your review page{? company} for {company}{/?} — same link as before, with the latest versions ready to look over:

{url}'
)
on conflict (id) do nothing;
