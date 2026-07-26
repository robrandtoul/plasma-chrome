-- 000350: the proposals queue can now amend and retire briefing entries, not just add.
--
-- WHY. Migration 000226 gave the proposals queue four kinds: add a house rule,
-- edit a house rule, add an example reply, or raise an advisory flag. That set
-- can only ever make the briefing BIGGER. There was no way to fix an example
-- reply that had gone wrong, and no way to take anything out at all.
--
-- It bit us on 2026-07-26. The July edit review (docs/ai-draft-edit-review-2026-07.md
-- §3.1) found that example reply 8 opens with "Lovely to hear from you", which is
-- exactly what house rule 40 forbids — the example was teaching the AI to break the
-- rule, and winning. The only way to file that finding was as an advisory
-- category_flag (proposal 36d761ab-5fc6-4db3-a7b4-3f2dadf4a61c) saying "someone go
-- and edit this by hand", because no kind existed that could do it.
--
-- Left as-is, an automatic edit-miner would grow the briefing without bound and
-- never prune it. This migration adds the three missing verbs:
--
--   exemplar_edit     — rewrite an existing example reply (and/or its customer message)
--   exemplar_retire   — take an example reply out of the briefing
--   house_rule_retire — take a house rule out of the briefing
--
-- Both retires are SOFT deletes (is_active = false), exactly like the Remove
-- button on the Briefing tab, so anything removed here can be restored there.
--
-- Everything about the existing four kinds is unchanged.
--
-- WHO CAN CALL THE APPLY FUNCTION. Unchanged from 000226 and re-stated verbatim
-- at the foot of this file: EXECUTE goes to `authenticated` — any signed-in
-- member of staff — with the Proposals page itself behind the admin-only route
-- guard. Worth saying out loud, because this migration does widen what that
-- grant reaches: a signed-in non-admin calling the function directly could now
-- RETIRE briefing entries, where before they could only add to or amend them.
-- Carried forward on purpose. The two briefing tables already carry an
-- `ALL to authenticated (true)` RLS policy from 000225, so the same person can
-- already set is_active = false on a rule by hand; tightening only this one
-- function would move nothing but the paperwork. If the briefing should be
-- admin-only, that is a decision about the whole surface — the tables, this
-- function and the Briefing tab together — and it is Rob's to make, not a side
-- effect of adding three verbs.

-- ── 1. The new kinds ─────────────────────────────────────────────────────────
alter table proofs.ai_draft_proposals
  drop constraint if exists ai_draft_proposals_kind_check;

alter table proofs.ai_draft_proposals
  add constraint ai_draft_proposals_kind_check check (kind in (
    'house_rule_add',
    'house_rule_edit',
    'house_rule_retire',
    'exemplar_add',
    'exemplar_edit',
    'exemplar_retire',
    'category_flag'
  ));

-- ── 2. Which example reply a proposal is about ───────────────────────────────
-- House-rule proposals already say which rule they target via target_rule_id.
-- Example replies need the same pointer. ON DELETE SET NULL matches target_rule_id:
-- if the example is hard-deleted the proposal survives as a record of what was
-- suggested, and the apply function below refuses to approve it (see §3).
alter table proofs.ai_draft_proposals
  add column if not exists target_exemplar_id uuid
    references proofs.ai_draft_exemplars(id) on delete set null;

comment on column proofs.ai_draft_proposals.target_exemplar_id is
  'For exemplar_edit / exemplar_retire: which example reply in ai_draft_exemplars this proposal changes.';

-- Grants on ai_draft_proposals are stated at table level (000226), so the new
-- column inherits them; nothing to re-state here.

-- ── 3. The apply RPC ─────────────────────────────────────────────────────────
-- Body is 000226's, verbatim for the four original kinds, with three branches
-- added and the rule/example branches grouped together for readability. The
-- branch tests are mutually exclusive, so grouping changes nothing about which
-- one runs.
--
-- The house rule throughout: if the thing we were asked to change is missing or
-- already inactive, raise. Raising rolls the whole transaction back, so the
-- proposal stays pending rather than being stamped "approved" when nothing
-- actually changed.
create or replace function proofs.apply_ai_draft_proposal(
  p_proposal_id uuid,
  p_decision    text,            -- 'approved' | 'rejected'
  p_note        text default null
) returns proofs.ai_draft_proposals
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_p         proofs.ai_draft_proposals;
  v_next_sort integer;
  v_reply     text;
  v_customer  text;
  v_category  text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected, got %', p_decision;
  end if;

  select * into v_p from proofs.ai_draft_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal % not found', p_proposal_id;
  end if;
  if v_p.status <> 'pending' then
    raise exception 'proposal % already %', p_proposal_id, v_p.status;
  end if;

  if p_decision = 'approved' then
    if v_p.kind = 'house_rule_add' then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from proofs.ai_draft_house_rules;
      insert into proofs.ai_draft_house_rules (sort_order, rule_text, source, proposal_id, updated_by)
        values (v_next_sort, v_p.proposed_text, 'proposal', v_p.id, auth.uid());

    elsif v_p.kind = 'house_rule_edit' then
      if v_p.target_rule_id is null then
        raise exception 'house_rule_edit proposal % has no target_rule_id', p_proposal_id;
      end if;
      update proofs.ai_draft_house_rules
        set rule_text = v_p.proposed_text, source = 'proposal', proposal_id = v_p.id,
            updated_at = now(), updated_by = auth.uid()
        where id = v_p.target_rule_id and is_active = true;
      -- Fail loudly (rolling the whole txn back, so the proposal stays pending)
      -- if the target rule was deleted/deactivated since the proposal was made —
      -- never mark an edit "approved" when nothing was actually edited.
      if not found then
        raise exception 'house_rule_edit target rule % is missing or inactive', v_p.target_rule_id;
      end if;

    elsif v_p.kind = 'house_rule_retire' then
      if v_p.target_rule_id is null then
        raise exception 'house_rule_retire proposal % has no target_rule_id', p_proposal_id;
      end if;
      -- Soft delete, identical to the Remove button on the Briefing tab, so the
      -- rule can be restored there. We deliberately leave source / proposal_id
      -- alone: those record where the rule's WORDING came from, and retiring
      -- doesn't rewrite the wording. Who retired it, and why, is on this
      -- proposal row (decided_by / decided_at) and in the audit log.
      update proofs.ai_draft_house_rules
        set is_active = false, updated_at = now(), updated_by = auth.uid()
        where id = v_p.target_rule_id and is_active = true;
      if not found then
        raise exception 'house_rule_retire target rule % is missing or already retired', v_p.target_rule_id;
      end if;

    elsif v_p.kind = 'exemplar_add' then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from proofs.ai_draft_exemplars;
      insert into proofs.ai_draft_exemplars (sort_order, category, customer_text, reply_text, source, proposal_id, updated_by)
        values (v_next_sort, coalesce(v_p.category, 'other'), coalesce(v_p.proposed_customer_text, ''),
                v_p.proposed_text, 'proposal', v_p.id, auth.uid());

    elsif v_p.kind = 'exemplar_edit' then
      if v_p.target_exemplar_id is null then
        raise exception 'exemplar_edit proposal % has no target_exemplar_id', p_proposal_id;
      end if;
      -- Same two columns exemplar_add uses: proposed_text is the new REPLY,
      -- proposed_customer_text the new CUSTOMER message.
      --
      -- WHATEVER IS SUPPLIED REPLACES THAT WHOLE SIDE. proposed_text becomes
      -- the entire reply_text; it is not merged into it, and there is no way to
      -- patch a sentence. So a proposal that wants only the opening line of an
      -- example changed (the July review's ask for example 8) must carry the
      -- WHOLE reply with that line already corrected. Send just the corrected
      -- opening line and the example silently shrinks to that one sentence —
      -- no error, because a one-sentence reply is a perfectly valid reply.
      --
      -- What IS partial is the choice of side: an edit may change the reply, or
      -- the customer message, or the category, in any combination. Empty or
      -- missing means "leave this side exactly as it is", never "blank it" — a
      -- proposal that only supplies a reply must not wipe the customer message.
      -- Blanking a side outright is not expressible here, and shouldn't be:
      -- both columns are NOT NULL and an example with half of it missing
      -- teaches nothing. A proposal that supplies none of the three is a no-op,
      -- so it raises rather than being stamped approved.
      -- btrim's character list spells out tabs and newlines because the one-arg
      -- form only strips spaces, and a "blank" pasted into a textarea is
      -- usually a stray newline.
      v_reply    := nullif(btrim(v_p.proposed_text, E' \t\r\n'), '');
      v_customer := nullif(btrim(v_p.proposed_customer_text, E' \t\r\n'), '');
      -- Category is usually just context ("this is about an artwork example"),
      -- in which case it matches what's already stored and re-writing it is a
      -- no-op. Supply a DIFFERENT category only when you mean to re-file the
      -- example; the review panel shows the before/after so it can't happen
      -- unnoticed.
      v_category := nullif(btrim(v_p.category, E' \t\r\n'), '');
      if v_reply is null and v_customer is null and v_category is null then
        raise exception 'exemplar_edit proposal % supplies no new text', p_proposal_id;
      end if;
      update proofs.ai_draft_exemplars
        set reply_text    = coalesce(v_reply, reply_text),
            customer_text = coalesce(v_customer, customer_text),
            category      = coalesce(v_category, category),
            source = 'proposal', proposal_id = v_p.id,
            updated_at = now(), updated_by = auth.uid()
        where id = v_p.target_exemplar_id and is_active = true;
      if not found then
        raise exception 'exemplar_edit target example % is missing or inactive', v_p.target_exemplar_id;
      end if;

    elsif v_p.kind = 'exemplar_retire' then
      if v_p.target_exemplar_id is null then
        raise exception 'exemplar_retire proposal % has no target_exemplar_id', p_proposal_id;
      end if;
      -- Soft delete; see the house_rule_retire note above for why source and
      -- proposal_id are left untouched.
      update proofs.ai_draft_exemplars
        set is_active = false, updated_at = now(), updated_by = auth.uid()
        where id = v_p.target_exemplar_id and is_active = true;
      if not found then
        raise exception 'exemplar_retire target example % is missing or already retired', v_p.target_exemplar_id;
      end if;
    end if;
    -- category_flag: advisory only, no briefing write.
  end if;

  update proofs.ai_draft_proposals
    set status = p_decision, decided_at = now(), decided_by = auth.uid(), decision_note = p_note
    where id = p_proposal_id
    returning * into v_p;
  return v_p;
end $$;

-- Re-stated per the 000226 tail. Designers call this from the Proposals panel
-- (admin-gated by the route); anon never touches the briefing.
revoke all on function proofs.apply_ai_draft_proposal(uuid, text, text) from public, anon;
grant execute on function proofs.apply_ai_draft_proposal(uuid, text, text) to authenticated;
