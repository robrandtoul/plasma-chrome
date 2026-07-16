-- 000317_nudge_bundle_reminders.sql
-- Follow-up automation: chase a whole BUNDLE (proof set) with ONE reminder
-- instead of silencing all its cards.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- Background: when two or more cards of one sent bundle come due on the same
-- run, groupSendables() saw them share the customer's email and suppressed ALL
-- of them (outcome 'suppressed_sibling'), leaving a human to send one combined
-- message. A bundle already has its own review link and its own Help Scout
-- thread, so it can be chased as a single unit. send-nudges now collapses a
-- bundle's due cards into one reminder booked against this new proof_set_id,
-- posted on the bundle's thread with the /bundle/:id?token link. A bundle down
-- to its LAST outstanding card is not a bundle any more — that card chases
-- individually on its own /p/ link (Rob, 2026-07-15).
--
-- This migration is additive and inert until the matching send-nudges deploy
-- lands: the column is nullable, the templates fall back to code defaults, and
-- no existing row references either.

-- ── Ledger: which set a reminder covers ─────────────────────────────────────
-- Null for every per-card reminder (unchanged). Set only on a bundle-level
-- reminder (rule_code = 'bundle'); the bundle cap + cooldown count by this.
-- ON DELETE SET NULL so deleting a set never orphans its reminder history.
alter table proofs.proof_nudges
  add column if not exists proof_set_id uuid
    references proofs.proof_sets(id) on delete set null;

comment on column proofs.proof_nudges.proof_set_id is
  'The proof set (bundle) a bundle-level reminder covers, when rule_code = ''bundle''. Null for per-card reminders. The bundle reminder cap/cooldown counts sent/sending rows by this column.';

-- Read index for the sender's per-set cap/cooldown lookup.
create index if not exists proof_nudges_set_idx
  on proofs.proof_nudges (proof_set_id, created_at desc)
  where proof_set_id is not null;

-- One automated bundle send per set per day, database-enforced — the same
-- backstop the existing proof_nudges_convo_daily index gives per conversation.
-- Skipped/dry_run rows (incl. the 'folded_into_bundle' member rows) are outside
-- the predicate, so they never trip it.
create unique index if not exists proof_nudges_bundle_daily
  on proofs.proof_nudges (proof_set_id, sent_date)
  where source = 'auto' and state in ('sending', 'sent') and proof_set_id is not null;

-- ── Bundle reminder bodies (reminder 1 / 2 / final) ─────────────────────────
-- Same house pattern as 000207/000313: ON CONFLICT DO NOTHING so an admin-edited
-- body is never clobbered; the default bodies mirror NUDGE_DEFAULT_BODIES in
-- supabase/functions/_shared/replyTemplates.ts and DEFAULT_BODIES in
-- src/lib/replyTemplates.ts. No sign-off — Help Scout appends the signature.
-- {url} is the bundle review link; no {version_number} (a bundle spans versions).
-- send-nudges resolves the position via nudgeTemplateIds('nudge_bundle', n, 3):
-- base body for reminder 1, _2 for the middle, _final ("we'll stop nudging you")
-- for the last allowed reminder — so a customer never gets the same one twice.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'nudge_bundle',
    'Bundle reminder 1 — cards awaiting review',
    'First automated reminder when a customer''s bundle still has cards awaiting review. Covers the whole set; {url} is the bundle review link.',
    E'Hi {first_name},\n\nJust checking the proofs of your cards{? company} for {company}{/?} reached you — a few are still waiting for your review. You can look over the whole set, and approve each one, here:\n\n{url}'
  ),
  (
    'nudge_bundle_2',
    'Bundle reminder 2 — cards awaiting review',
    'Second automated bundle reminder. Different wording from reminder 1 so the customer never receives the same email twice; invites a quick reply to pause the chasing.',
    E'Hi {first_name},\n\nCircling back on your card proofs{? company} for {company}{/?} — a few are still waiting for the go-ahead. It only takes a minute to review the set and approve the ones you''re happy with:\n\n{url}\n\nIf now isn''t a good time, just reply and let us know — we''ll hold off on the reminders.'
  ),
  (
    'nudge_bundle_final',
    'Bundle final reminder — cards awaiting review',
    'Last automated bundle reminder. Closes the loop: says it is the last one, reassures the proofs stay saved, and asks for a one-line reply if something is wrong.',
    E'Hi {first_name},\n\nWe haven''t managed to reach you about your card proofs{? company} for {company}{/?}, so this is our last reminder — we don''t want to clutter your inbox.\n\nYour proofs stay saved, and you can review the set any time:\n\n{url}\n\nIf the timing''s wrong or something''s not quite right, a one-line reply is all it takes.'
  )
on conflict (id) do nothing;
