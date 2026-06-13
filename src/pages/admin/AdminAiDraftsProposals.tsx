import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { Pill, type PillColour, ButtonInk, ButtonGhost } from '../../design'

// Phase 3b — the human-in-the-loop approval queue. Suggestions (from the future
// edit-miner, or hand-written) land here as PENDING proposals; an admin approves
// or rejects each. Approving is the ONLY path from a proposal into the live
// briefing, via the SECURITY DEFINER apply_ai_draft_proposal RPC (migration
// 000226) — nothing here ever changes a live draft until you click Approve.

type Kind = 'house_rule_add' | 'house_rule_edit' | 'exemplar_add' | 'category_flag'
type Status = 'pending' | 'approved' | 'rejected' | 'superseded'

interface Evidence {
  ai_draft_id?: string
  helpscout_conversation_id?: string | number
  edit_class?: string
  similarity?: number
}
interface Proposal {
  id: string
  created_at: string
  kind: Kind
  category: string | null
  target_rule_id: string | null
  proposed_text: string | null
  proposed_customer_text: string | null
  rationale: string
  evidence: Evidence[]
  recurrence_count: number
  reviewer_disagreement: boolean
  status: Status
  decided_at: string | null
  decision_note: string | null
}

const KIND_LABEL: Record<Kind, string> = {
  house_rule_add: 'New rule',
  house_rule_edit: 'Edit rule',
  exemplar_add: 'New example',
  category_flag: 'Category flag',
}
const STATUS_PILL: Record<Status, PillColour> = {
  pending: 'allocated', approved: 'in-stock', rejected: 'out', superseded: 'mute',
}

export default function AdminAiDraftsProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('ai_draft_proposals')
      .select('id, created_at, kind, category, target_rule_id, proposed_text, proposed_customer_text, rationale, evidence, recurrence_count, reviewer_disagreement, status, decided_at, decision_note')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) { setError(error.message); setLoading(false); return }
    setProposals((data ?? []) as Proposal[])
    setLoading(false)
  }

  async function decide(p: Proposal, decision: 'approved' | 'rejected') {
    setWorking(p.id); setActionError(null)
    const { data, error } = await supabase.rpc('apply_ai_draft_proposal', {
      p_proposal_id: p.id, p_decision: decision, p_note: null,
    })
    setWorking(null)
    if (error) { setActionError(error.message); return }
    const updated = (data ?? { ...p, status: decision }) as Proposal
    setProposals((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...updated } : x)))
    void logAudit({
      action: decision === 'approved' ? 'ai_proposal.approved' : 'ai_proposal.rejected',
      targetType: 'ai_draft_proposal', targetId: p.id,
      afterValue: { kind: p.kind, category: p.category },
    })
  }

  if (loading) return <p className="text-ink-mute text-sm">Loading proposals…</p>
  if (error) return <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink"><span className="text-[var(--c-out)]">Couldn’t load:</span> {error}</div>

  const pending = proposals.filter((p) => p.status === 'pending')
  const decided = proposals.filter((p) => p.status !== 'pending')

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-mute -mt-2">
        Suggestions to improve the briefing, drawn from how the team edits drafts. Approving applies the change to the live
        briefing on the next email; rejecting discards it. Nothing here changes a draft until you decide.
      </p>

      {actionError && <p className="text-sm text-[var(--c-out)]">{actionError}</p>}

      {proposals.length === 0 && (
        <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-mute">
          No proposals yet. The suggestion engine starts once there’s enough feedback history to spot a pattern — until then this stays empty.
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink">Pending ({pending.length})</h2>
          {pending.map((p) => <ProposalCard key={p.id} p={p} working={working === p.id} onDecide={decide} />)}
        </div>
      )}

      {decided.length > 0 && (
        <div className="space-y-3 pt-2">
          <h2 className="text-sm font-medium text-ink">Decided ({decided.length})</h2>
          {decided.map((p) => <ProposalCard key={p.id} p={p} working={false} onDecide={decide} />)}
        </div>
      )}
    </div>
  )
}

function ProposalCard({ p, working, onDecide }: { p: Proposal; working: boolean; onDecide: (p: Proposal, d: 'approved' | 'rejected') => void }) {
  const isFlag = p.kind === 'category_flag'
  return (
    <div className="rounded-lg border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill colour="neutral">{KIND_LABEL[p.kind]}</Pill>
        {p.category && <Pill colour="mute">{p.category}</Pill>}
        <Pill colour={STATUS_PILL[p.status]}>{p.status}</Pill>
        {p.recurrence_count > 0 && <span className="text-xs text-ink-dim">seen in {p.recurrence_count} conversation{p.recurrence_count === 1 ? '' : 's'}</span>}
        {p.reviewer_disagreement && <Pill colour="low">team disagreed</Pill>}
        <span className="ml-auto text-xs text-ink-dim">{new Date(p.created_at).toLocaleDateString('en-GB')}</span>
      </div>

      <div>
        <div className="eyebrow text-ink-mute mb-1">Why</div>
        <p className="text-sm text-ink">{p.rationale}</p>
      </div>

      {!isFlag && p.proposed_text && (
        <div>
          <div className="eyebrow text-ink-mute mb-1">{p.kind === 'house_rule_edit' ? 'Proposed wording' : p.kind === 'exemplar_add' ? 'Proposed example reply' : 'Proposed rule'}</div>
          {p.kind === 'exemplar_add' && p.proposed_customer_text && (
            <p className="text-xs text-ink-mute whitespace-pre-wrap mb-2 bg-canvas border border-line-soft rounded-[8px] p-2">Customer: {p.proposed_customer_text}</p>
          )}
          <pre className="whitespace-pre-wrap font-sans text-sm text-ink bg-canvas border border-line-soft rounded-[8px] p-3 leading-relaxed">{p.proposed_text}</pre>
        </div>
      )}

      {p.evidence?.length > 0 && (
        <details>
          <summary className="text-xs text-ink-soft cursor-pointer">Evidence ({p.evidence.length})</summary>
          <ul className="mt-2 space-y-1">
            {p.evidence.map((ev, i) => (
              <li key={i} className="text-xs text-ink-mute flex items-center gap-2">
                {ev.edit_class && <Pill colour="mute">{ev.edit_class}</Pill>}
                {ev.similarity != null && <span className="tabular-nums">{Math.round(ev.similarity * 100)}% match</span>}
                {ev.helpscout_conversation_id != null && (
                  <a href={`https://secure.helpscout.net/conversation/${ev.helpscout_conversation_id}`} target="_blank" rel="noreferrer" className="text-[var(--c-brand)] hover:underline">open conversation</a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {p.status === 'pending' && (
        <div className="flex items-center gap-2 pt-1">
          <ButtonInk onClick={() => onDecide(p, 'approved')} disabled={working}>{working ? '…' : isFlag ? 'Acknowledge' : 'Approve'}</ButtonInk>
          <ButtonGhost onClick={() => onDecide(p, 'rejected')} disabled={working}>{isFlag ? 'Dismiss' : 'Reject'}</ButtonGhost>
        </div>
      )}
      {p.status !== 'pending' && p.decision_note && <p className="text-xs text-ink-dim">Note: {p.decision_note}</p>}
    </div>
  )
}
