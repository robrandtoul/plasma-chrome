-- 000313_nudge_reminder_sequence.sql
-- Auto-chase review (2026-07-13): varied reminder bodies + a lower cap.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- The live ledger shows each chase rule re-sending the SAME body verbatim up
-- to four times, with hard diminishing returns (reminder 1 re-engages ~40-48%
-- of customers, reminder 3-4 ~0-20% and almost no decisions). Two changes:
--
-- 1. Seed per-position reminder bodies. send-nudges now resolves the template
--    by reminder number: the existing per-rule ids stay reminder #1;
--    `<rule>_2` covers the middle of the sequence; `<rule>_final` is the last
--    allowed reminder — a "we'll stop nudging you" close that gives a
--    face-saving out and asks why (price/timing/direction) when the answer is
--    no. The vna #2 body addresses price directly — the conversion analysis
--    found price is the #1 stated loss reason, and this population has seen
--    the price grid. Same house pattern as 000207/000312: ON CONFLICT DO
--    NOTHING so admin edits are never clobbered; bodies mirror DEFAULT_BODIES
--    in src/lib/replyTemplates.ts (and NUDGE_DEFAULT_BODIES in the edge twin);
--    no sign-off (Help Scout appends the signature); nudge_ prefix puts them
--    in the admin editor's "Needs-attention reminders" group with the
--    designer_picked variable chips.
--
-- 2. Cap automated reminders at 3 per (proof, rule, version), down from the
--    live 4. Reminder #4 re-engaged 1 of 8 mature sends and produced zero
--    decisions — with the breakup body at position 3 the fourth email has no
--    job left to do. NOTE the one-time side effect: proofs that already have
--    3-4 sends on their current version become capped immediately, so the
--    nudges_exhausted needs-attention pile will grow for a few days as the
--    in-flight backlog surfaces for a human — that is the honest state, not a
--    regression. Assumes the automation blocks exist (they do on live, seeded
--    by 000244); jsonb_set create_missing only creates the leaf key.

insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'nudge_sent_never_viewed_2',
    'Reminder 2 — sent but never opened',
    'Second automated reminder when a proof still has not been opened. Different wording from reminder 1 so the customer never receives the same email twice; invites a quick reply to pause the chasing.',
    E'Hi {first_name},\n\nEmails have a way of getting buried, so here''s the link to the proof of your cards{? company} for {company}{/?} again — it only takes a minute to look over:\n\n{url}\n\nIf now isn''t a good time, just reply and let us know — we''ll hold off on the reminders.'
  ),
  (
    'nudge_sent_never_viewed_final',
    'Final reminder — sent but never opened',
    'Last automated reminder when a proof was never opened. Closes the loop: says it is the last one, reassures the proof stays saved, and asks for a one-line reply if something is wrong.',
    E'Hi {first_name},\n\nWe haven''t managed to reach you about your card proof{? company} for {company}{/?}, so this is our last reminder — we don''t want to clutter your inbox.\n\nYour proof stays saved, and you can pick it up any time:\n\n{url}\n\nIf the timing''s wrong or something''s not quite right, a one-line reply is all it takes.'
  ),
  (
    'nudge_viewed_not_actioned_2',
    'Reminder 2 — viewed, awaiting a decision',
    'Second automated reminder when a proof has been viewed but not decided on. Single clear ask (approve on the page, or reply with changes) and addresses price head-on — the most common unspoken blocker.',
    E'Hi {first_name},\n\nJust picking up on the proof of your cards{? company} for {company}{/?}. If you''re happy with it, you can approve it on the page in a few seconds — and if you''d like anything changed (layout, wording, colours), just reply and we''ll sort it:\n\n{url}\n\nIf it''s the price giving you pause, tell us — there''s often a more affordable route with a different material or quantity.'
  ),
  (
    'nudge_viewed_not_actioned_final',
    'Final reminder — viewed, awaiting a decision',
    'Last automated reminder when a viewed proof still has no decision. Closes the loop: says it is the last one, keeps the door open, and asks why (price, timing, direction) if the answer is no.',
    E'Hi {first_name},\n\nThis is our last reminder about your card proof{? company} for {company}{/?} — we don''t want to be a pest. Your proof stays saved, so you can come back to it whenever suits:\n\n{url}\n\nIf you''ve decided not to go ahead, no hard feelings — a quick reply telling us why (price, timing, direction) genuinely helps us do better.'
  )
on conflict (id) do nothing;

-- Cap: 4 → 3 automated reminders per (proof, rule, version) for both
-- auto-send rules. repeat_days stays 3 — the sender now stretches the gap
-- itself as the sequence progresses (3 working days before reminder 2, 5
-- before reminder 3; see COOLDOWN_STRETCH_WD in _shared/nudgeDecision.ts).
update proofs.site_settings
set needs_attention_rules = jsonb_set(
  jsonb_set(
    needs_attention_rules,
    '{automation,sent_never_viewed,max_nudges}', to_jsonb(3), true
  ),
  '{automation,viewed_not_actioned,max_nudges}', to_jsonb(3), true
)
where id = 1
  and needs_attention_rules ? 'automation';
