-- 000281: per-user "feedback board last seen" timestamp.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this.
--
-- Closes the feedback loop: when an admin moves someone's feedback item to
-- `done` / `wont_do`, the submitter currently gets no signal — resolved items
-- drop behind the board's Resolved filter and nobody is told. This column lets
-- us mark, per person, when they last looked at the feedback board, so the
-- header can badge "N of your suggestions were resolved since you last looked"
-- and the board can highlight exactly those rows.
--
-- "News for me" is then computed entirely client-side as the person's own
-- feedback_items with status in (done, wont_do) and status_changed_at later
-- than this column (src/lib/feedback.ts isUnseenResolved). The frontend stamps
-- this to now() whenever the board is opened.
--
-- DEFAULT now() does two jobs in one line:
--   * existing rows are backfilled to the apply time, so the very first
--     rollout does NOT badge everyone with a pile of historical resolutions —
--     only items resolved *after* this ships count as new.
--   * future profiles (a new designer) are born "seen as of creation", which
--     is correct: their own items can only ever be created after their
--     profile exists.
-- Left nullable (no NOT NULL) so no insert path can ever fail on it; the
-- frontend treats a null baseline as "everything resolved is new", which only
-- the (here-backfilled) pre-existing rows could have hit.
--
-- Adding a column inherits proofs.profiles' existing grants (authenticated
-- already has UPDATE — migration 000176), and the owner-update RLS policy
-- (000171) only locks role / helpscout_user_id / deactivated_at, so the row
-- owner can write this field freely. No grant or policy change needed.
-- `if not exists` for safe replay.

alter table proofs.profiles
  add column if not exists feedback_seen_at timestamptz default now();

comment on column proofs.profiles.feedback_seen_at is
  'When this user last opened the feedback board. Drives the "your suggestion was resolved" header badge + on-board highlight. Stamped to now() on every board visit; backfilled to apply time in 000281.';
