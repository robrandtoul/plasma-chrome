-- 000361: seed the editable workshop-note template (order hand-off Phase 3).
--
-- The in-house production note was generated line-by-line in `place-order` and
-- had to keep a strict shape because Stock Control's importer read it. It no
-- longer does — the job is written directly by `create_order_handoff`, and both
-- Stock Control importers now recognise a directly-written job and stay quiet
-- (deployed 2026-07-27) — so the note is an ordinary human message and its
-- wording belongs to whoever writes it.
--
-- ⚠ The body below reproduces the previously-generated note EXACTLY, so the day
-- this ships the workshop sees no change at all. Every optional line is a
-- conditional block ({? var}…{/?}), matching the existing renderer in
-- _shared/replyTemplates.ts — the same syntax the nudge and order-reminder
-- templates already use — so a value that isn't set leaves no dangling label.
--
-- `place-order` falls back to a byte-identical constant if this row is missing
-- or blank, so seeding is belt-and-braces rather than load-bearing.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'inhouse_production_note',
    'Workshop note',
    'The note posted to the customer''s Help Scout conversation when an in-house order is placed, so the workshop has the job details in one place. Stock Control no longer reads this — the job is created directly — so the wording is yours to change.',
    E'{? prototype_warning}{prototype_warning}\n{/?}Qty: {qty}\nCard: {card}{? date_required}\nDate required: {date_required}{/?}{? ink_front}\nInk on front: {ink_front}{/?}{? ink_back}\nInk on back: {ink_back}{/?}{? packaging}\nPackaging: {packaging}{/?}{? per_person}\n{per_person}{/?}{? artwork_link}\nArtwork: {artwork_link}{/?}{? note}\n\n{note}{/?}'
  )
on conflict (id) do nothing;
