-- AI drafts: record whether the "sent reply" we scored a draft against was an
-- edit of that draft at all (docs/ai-draft-edit-review-2026-07.md §1).
--
-- How the feedback loop works today: when a staff reply goes out, the ai-draft
-- function finds the newest published staff reply sent after the draft and
-- measures how far it drifted (edit_similarity / edit_class). That assumes the
-- next thing the team sends is the draft, edited. Very often it is not — it is
-- the proof delivery, the order link, the payment confirmation, an automated
-- chase, or a one-line aside. Scored as an edit, those all land in
-- 'discarded'.
--
-- Measured read-only against live on 2026-07-26: 97 of the 248 'discarded'
-- rows (39%) are one of those, not a rejected draft. So the acceptance figure
-- on the Drafts panel currently reads worse than reality, and the rising
-- 'discarded' share partly tracks proof-delivery volume rather than draft
-- quality.
--
-- What these columns are FOR, then, is two things and not a third:
--   1. The acceptance metric. It divides accepted drafts by matched drafts,
--      and roughly two fifths of the 'discarded' denominator is proof
--      deliveries and order emails. Taking them out is the point.
--   2. Trust in the label. Someone reading a 'discarded' row can see it was
--      the order-link email rather than opening Help Scout to discover the
--      team never rejected anything.
-- NOT protecting the Phase 3c pattern miner, which is the obvious guess and
-- is wrong: the miner only reads edit_class 'lightly_edited' or 'rewritten',
-- both of which mean similarity >= 0.45, and classifyMatch returns 'edit'
-- unconditionally at that similarity. The two sets cannot overlap, so the
-- miner's feedback_match_quality filter excludes zero rows — verified against
-- all 529 matched rows on live. The filter stays as a guard in case a
-- threshold moves; it is not doing work today.
--
-- These two columns hold the verdict from classifyMatch() in
-- _shared/aiDrafts/feedback.ts:
--   feedback_match_quality  'edit'      — plausibly an edited version of the draft
--                           'unrelated' — a different message entirely
--   feedback_match_reason   why, machine-readable: proof_delivery, order_message,
--                           stale_draft, different_message
--
-- Deliberately SEPARATE from edit_class rather than a fifth value on it.
-- edit_class answers "how much did they change it", this answers "were they
-- even changing it" — folding them together would break every consumer of the
-- existing four values, and the classifier is conservative enough that a row
-- can honestly be both 'discarded' and a real edit.
--
-- No backfill, on purpose. NULL means "not assessed", which is every row
-- measured before today. Anything reading these columns — the miner, the
-- acceptance chart — must treat NULL as INCLUDABLE, i.e. exclude only where
-- feedback_match_quality = 'unrelated'. A `<> 'unrelated'` filter would
-- silently drop the entire back catalogue, since NULL <> 'unrelated' is NULL.
--
-- Grants: none needed and none given. Table-level privileges in Postgres cover
-- columns added later, and proofs.ai_drafts already sits where it should —
-- SELECT to authenticated (the admin Drafts panel reads it), everything to
-- service_role (the ai-draft edge function writes it), and nothing at all to
-- anon. Verified against live before writing this; deliberately not restated,
-- so there is no chance of widening it by accident.
--
-- ⚠ MIGRATION FIRST, THEN THE ai-draft DEPLOY. (An earlier draft of this header
-- said either order was fine; that was written before the function was wired to
-- WRITE these columns, and it is now wrong.) The redeployed captureFeedback
-- names feedback_match_quality and feedback_match_reason in its update, and
-- PostgREST rejects the WHOLE update on an unknown column — so deploying first
-- breaks the feedback capture that works today, permanently: the row keeps
-- feedback_matched_at IS NULL, so every retry fails the same way and nothing is
-- ever recorded.
--
-- Additive otherwise: existing rows keep NULL, and NULL means "not assessed"
-- rather than "was an edit". Apply via MCP / the dashboard SQL editor per the
-- house workflow — never CLI push.

alter table proofs.ai_drafts
  add column if not exists feedback_match_quality text,
  add column if not exists feedback_match_reason text;

-- Both columns get a CHECK, matching every other enum-ish column on this table
-- (edit_class, skip_kind, mode, state all have one). Named + guarded so a
-- replay is a no-op. Neither column exists on live before this migration runs,
-- so every row is NULL and both checks validate instantly; no NOT VALID dance
-- needed.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'proofs.ai_drafts'::regclass
      and conname = 'ai_drafts_feedback_match_quality_check'
  ) then
    alter table proofs.ai_drafts
      add constraint ai_drafts_feedback_match_quality_check
      check (feedback_match_quality is null or feedback_match_quality in ('edit', 'unrelated'));
  end if;
end $$;

-- The reason check does double duty: it pins the four values classifyMatch can
-- return, AND it enforces the promise the column comment makes — a reason only
-- ever accompanies an 'unrelated' verdict. Without it, "why was this thrown
-- out?" could be answered on a row that was never thrown out, and nothing but
-- convention would stop a fifth reason appearing in the data before anything
-- reading it knew the value existed.
--
-- Deliberately NOT requiring a reason when the quality IS 'unrelated'.
-- classifyMatch always supplies one, but this table is written by a live edge
-- function on the customer-reply path: a future caller that records only the
-- verdict should get a slightly less useful row, not a failed write.
--
-- `is not distinct from` rather than `=` because feedback_match_quality is
-- nullable, and in SQL `null = 'unrelated'` is NULL, not false. A CHECK that
-- evaluates to NULL counts as SATISFIED — so with a plain `=` a row carrying a
-- reason but no verdict at all would sail straight through the constraint
-- meant to forbid it. Same reasoning as migration 000171 on profiles.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'proofs.ai_drafts'::regclass
      and conname = 'ai_drafts_feedback_match_reason_check'
  ) then
    alter table proofs.ai_drafts
      add constraint ai_drafts_feedback_match_reason_check
      check (
        feedback_match_reason is null
        or (
          feedback_match_quality is not distinct from 'unrelated'
          and feedback_match_reason in (
            'proof_delivery', 'order_message', 'stale_draft', 'different_message'
          )
        )
      );
  end if;
end $$;

comment on column proofs.ai_drafts.feedback_match_quality is
  'Was the matched staff reply an edit of this draft at all? ''edit'' | ''unrelated'' | NULL = not assessed (every row before 2026-07-26). Treat NULL as includable: filter on = ''unrelated'' to exclude, never on <> ''unrelated''.';

comment on column proofs.ai_drafts.feedback_match_reason is
  'Why the match was judged unrelated: proof_delivery | order_message | stale_draft | different_message. NULL whenever the quality is ''edit'' or unassessed.';
