-- 000286: resolution note on feedback items — the "what I did & how it works"
-- explanation an admin writes when resolving a request, surfaced to the team.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this.
--
-- Distinct from the existing `admin_note` (a lightweight running triage note,
-- any status): resolution_note is the completion deliverable, written when an
-- item is moved to done / wont_do, and rendered as a prominent "What we did /
-- Why we closed this" panel on the board so the whole team learns what shipped
-- and how to use it. Kept as its own column rather than overloading admin_note
-- so the two can be presented differently and a mid-flight note isn't clobbered
-- by the final explanation.
--
-- Additive + nullable, no default. Existing rows stay null (no false "we
-- explained this"). Reads: feedback_items_select is `true` for all
-- authenticated, so everyone sees it. Writes: feedback_items_admin_update is
-- gated on proofs.is_admin() with no column lock, so an admin can populate it
-- via the same triage path that already writes admin_note. The column inherits
-- the table's existing authenticated grants — no grant or policy change needed.
-- `if not exists` for safe replay.

alter table proofs.feedback_items
  add column if not exists resolution_note text;

comment on column proofs.feedback_items.resolution_note is
  'Admin-written "what I did & how it works" explanation, set when resolving (done/wont_do). Shown to the whole team on the board. Distinct from admin_note (lightweight running triage note). Added in 000286.';
