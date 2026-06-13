-- 000226: AI-draft proposals queue + apply RPC (Phase 3b).
--
-- The human-in-the-loop surface. The (future, Phase 3c) edit-miner and any
-- hand-written suggestions land here as PENDING proposals; an admin approves or
-- rejects each one in the Drafts panel. Approving a proposal is the ONLY write
-- path from a proposal into the live briefing tables, and it runs through the
-- SECURITY DEFINER apply RPC below — nothing a machine suggests ever changes a
-- live draft until a human clicks Approve.
--
-- The proofs schema has NO default privileges: every grant is stated explicitly.

create table if not exists proofs.ai_draft_proposals (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  -- groups the proposals from one miner run, so a batch can be reviewed together
  batch_id               uuid,
  kind                   text not null check (kind in ('house_rule_add', 'house_rule_edit', 'exemplar_add', 'category_flag')),
  -- the drafted category this concerns (nullable; advisory for category_flag)
  category               text,
  -- for house_rule_edit: which rule it rewrites
  target_rule_id         uuid references proofs.ai_draft_house_rules(id) on delete set null,
  -- the new/edited rule text, or (for exemplar_add) the example REPLY
  proposed_text          text,
  -- for exemplar_add: the example CUSTOMER message
  proposed_customer_text text,
  rationale              text not null,
  -- [{ ai_draft_id, helpscout_conversation_id, edit_class, similarity }] — the
  -- ledger rows that support the proposal, so a reviewer can open the evidence
  evidence               jsonb not null default '[]'::jsonb,
  -- distinct conversations supporting it (the miner's recurrence gate)
  recurrence_count       integer not null default 0,
  reviewer_disagreement  boolean not null default false,
  status                 text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
  decided_at             timestamptz,
  decided_by             uuid,
  decision_note          text
);

create index if not exists ai_draft_proposals_pending_idx
  on proofs.ai_draft_proposals (created_at desc) where status = 'pending';

alter table proofs.ai_draft_proposals enable row level security;

-- Designers READ all proposals (the panel). The miner (service_role) inserts.
-- Designers do NOT get direct INSERT/UPDATE/DELETE — every status change flows
-- through apply_ai_draft_proposal so the briefing write and the stamp are
-- atomic and auditable. anon is never granted.
grant select on proofs.ai_draft_proposals to authenticated;
grant all on proofs.ai_draft_proposals to service_role;
revoke all on proofs.ai_draft_proposals from anon, public;

create policy ai_draft_proposals_read on proofs.ai_draft_proposals
  for select to authenticated using (true);

-- The single write path from a proposal into the briefing tables. On approve,
-- materialise the proposal (source='proposal', proposal_id set) and stamp it;
-- on reject, just stamp. category_flag is advisory — approving it only
-- acknowledges (no briefing write). All-or-nothing in one transaction.
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

    elsif v_p.kind = 'exemplar_add' then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from proofs.ai_draft_exemplars;
      insert into proofs.ai_draft_exemplars (sort_order, category, customer_text, reply_text, source, proposal_id, updated_by)
        values (v_next_sort, coalesce(v_p.category, 'other'), coalesce(v_p.proposed_customer_text, ''),
                v_p.proposed_text, 'proposal', v_p.id, auth.uid());
    end if;
    -- category_flag: advisory only, no briefing write.
  end if;

  update proofs.ai_draft_proposals
    set status = p_decision, decided_at = now(), decided_by = auth.uid(), decision_note = p_note
    where id = p_proposal_id
    returning * into v_p;
  return v_p;
end $$;

revoke all on function proofs.apply_ai_draft_proposal(uuid, text, text) from public, anon;
grant execute on function proofs.apply_ai_draft_proposal(uuid, text, text) to authenticated;
