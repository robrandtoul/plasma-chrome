import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { Pill, type PillColour, ButtonInk, ButtonGhost } from '../../design'
import { Toggle } from './settingsControls'

// Phase 3b — the human-in-the-loop approval queue. Suggestions (from the future
// edit-miner, or hand-written) land here as PENDING proposals; an admin approves
// or rejects each. Approving is the ONLY path from a proposal into the live
// briefing, via the SECURITY DEFINER apply_ai_draft_proposal RPC (migration
// 000226) — nothing here ever changes a live draft until you click Approve.
//
// Migration 000350 added three more verbs: edit an example reply, remove an
// example reply, remove a house rule. For any of those the card also shows the
// briefing entry AS IT STANDS TODAY, so the reviewer reads a before/after
// instead of a paragraph with nothing to compare it against.
//
// The card also refuses to offer Approve on a proposal that plainly can't be
// applied — one that never says which entry it means, or supplies no new
// wording. Those are the mistakes a machine-written proposal is likeliest to
// make, and the database's own complaint about them ("has no
// target_exemplar_id") means nothing to whoever is reading the queue.

type Kind =
  | 'house_rule_add'
  | 'house_rule_edit'
  | 'house_rule_retire'
  | 'exemplar_add'
  | 'exemplar_edit'
  | 'exemplar_retire'
  | 'category_flag'
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
  target_exemplar_id: string | null
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

// The briefing entries a proposal points at, fetched so the card can show
// what's live today alongside what's being proposed.
interface TargetRule { id: string; rule_text: string; is_active: boolean }
interface TargetExemplar { id: string; category: string; customer_text: string; reply_text: string; is_active: boolean }
interface Targets {
  rules: Record<string, TargetRule>
  exemplars: Record<string, TargetExemplar>
  // False when the lookup failed. Without this we'd read "couldn't fetch it" as
  // "it's been deleted" and warn the reviewer about a problem that isn't there.
  loaded: boolean
}
const NO_TARGETS: Targets = { rules: {}, exemplars: {}, loaded: false }

const KIND_LABEL: Record<Kind, string> = {
  house_rule_add: 'New rule',
  house_rule_edit: 'Edit rule',
  house_rule_retire: 'Remove rule',
  exemplar_add: 'New example',
  exemplar_edit: 'Edit example',
  exemplar_retire: 'Remove example',
  category_flag: 'Category flag',
}
// The two removals get a warmer pill so a destructive proposal doesn't look
// the same as an addition at a glance.
const KIND_PILL: Record<Kind, PillColour> = {
  house_rule_add: 'neutral',
  house_rule_edit: 'neutral',
  house_rule_retire: 'low',
  exemplar_add: 'neutral',
  exemplar_edit: 'neutral',
  exemplar_retire: 'low',
  category_flag: 'neutral',
}
const PROPOSED_LABEL: Record<Kind, string> = {
  house_rule_add: 'Proposed rule',
  house_rule_edit: 'Proposed wording',
  house_rule_retire: '',
  exemplar_add: 'Proposed example reply',
  exemplar_edit: 'Proposed example reply',
  exemplar_retire: '',
  category_flag: '',
}
const STATUS_PILL: Record<Status, PillColour> = {
  pending: 'allocated', approved: 'in-stock', rejected: 'out', superseded: 'mute',
}

// The apply function decides what a proposal actually supplies by trimming the
// text and treating "nothing left" as "not supplied" (btrim + nullif, migration
// 000350). Mirror that here, or a proposal carrying a stray newline shows the
// reviewer an empty-looking box and a promise that the reply is about to
// change, then quietly changes nothing when they approve it.
//
// Deliberately not JavaScript's own .trim(): that strips every kind of Unicode
// space, where Postgres was handed this exact four-character list. Matching it
// character for character is the point.
function supplied(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  return trimmed === '' ? null : trimmed
}

// PostgREST's code for "column does not exist". Netlify deploys on merge and
// Rob applies the migrations by hand afterwards, so this tab can be live on a
// database that predates its newest columns — and PostgREST fails the WHOLE
// select on one missing column, taking the queue down with it rather than
// costing us a single field. The ONLY error we work around by dropping a
// column: a timeout or a dropped connection must never be read as "this
// database is older than we thought".
const UNDEFINED_COLUMN = '42703'

// Everything on ai_draft_proposals that has been there since 000226.
const PROPOSAL_BASE_COLUMNS =
  'id, created_at, kind, category, target_rule_id, proposed_text, proposed_customer_text, rationale, evidence, recurrence_count, reviewer_disagreement, status, decided_at, decision_note'
// Added by 000350, along with the three exemplar/retire kinds that use it.
const PROPOSAL_EXEMPLAR_COLUMN = 'target_exemplar_id'

// Kinds that must name the briefing entry they change. Getting this wrong is
// the likeliest bug in a machine-written proposal, so the card checks it.
const NEEDS_TARGET_RULE: Kind[] = ['house_rule_edit', 'house_rule_retire']
const NEEDS_TARGET_EXEMPLAR: Kind[] = ['exemplar_edit', 'exemplar_retire']
// Kinds where the proposed text IS the change; without it there's nothing to write.
const NEEDS_PROPOSED_TEXT: Kind[] = ['house_rule_add', 'house_rule_edit', 'exemplar_add']

export default function AdminAiDraftsProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [targets, setTargets] = useState<Targets>(NO_TARGETS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // False when target_exemplar_id (migration 000350) isn't on the database yet.
  // Nothing is lost by its absence — the same migration adds the three kinds
  // that use it, so no row can want it — but the card must not then tell the
  // reviewer a proposal "doesn't say which example it means".
  const [hasExemplarTarget, setHasExemplarTarget] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const read = (withExemplar: boolean) =>
      supabase
        .from('ai_draft_proposals')
        .select(withExemplar ? `${PROPOSAL_BASE_COLUMNS}, ${PROPOSAL_EXEMPLAR_COLUMN}` : PROPOSAL_BASE_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(200)

    let res = await read(true)
    let withExemplar = true
    if (res.error?.code === UNDEFINED_COLUMN) {
      withExemplar = false
      res = await read(false)
    }
    setHasExemplarTarget(withExemplar)
    if (res.error) { setError(res.error.message); setLoading(false); return }
    // An absent column arrives as undefined, not null, and every check below
    // tests for null — so fill it in once here.
    const rows = ((res.data ?? []) as unknown as Proposal[]).map((r) => ({
      ...r,
      target_exemplar_id: r.target_exemplar_id ?? null,
    }))
    setProposals(rows)
    setTargets(await loadTargets(rows))
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
    // Approving rewrote or retired a briefing entry, so the "today" text other
    // cards are showing is now stale. Re-read it.
    if (decision === 'approved') setTargets(await loadTargets(proposals))
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

      <MinerSwitch />

      {proposals.length === 0 && (
        <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-mute">
          No proposals yet. They arrive when the edit-miner is run and finds a pattern in how the team has been editing
          drafts — it needs the switch above turned on, and someone to run it.
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink">Pending ({pending.length})</h2>
          {pending.map((p) => <ProposalCard key={p.id} p={p} targets={targets} hasExemplarTarget={hasExemplarTarget} working={working === p.id} onDecide={decide} />)}
        </div>
      )}

      {decided.length > 0 && (
        <div className="space-y-3 pt-2">
          <h2 className="text-sm font-medium text-ink">Decided ({decided.length})</h2>
          {decided.map((p) => <ProposalCard key={p.id} p={p} targets={targets} hasExemplarTarget={hasExemplarTarget} working={false} onDecide={decide} />)}
        </div>
      )}
    </div>
  )
}

// ── The edit-miner's on switch ───────────────────────────────────────────────
// settings.ai_draft_miner_enabled (migration 000353). The miner is what fills
// this queue, which is why the switch lives on this tab rather than in Admin →
// Settings — migration 000353's own header says so.
//
// Two locks stand between the miner and this queue: this flag, and an explicit
// "dry_run": false on the request. Neither lets it near the live briefing —
// an admin approving a proposal is still the only path in.
//
// Reads and writes the singleton proofs.settings row exactly the way every
// other admin boolean does (AdminArtworkCheckPage's save(), the Follow-ups
// master switch): optimistic set, roll back and show the message on failure,
// its own audit action. Note the update is AWAITED — a bare
// `void supabase.from(...).update(...)` never sends the request at all, which
// has shipped as a real bug in this repo before (see CLAUDE.md, "supabase-js
// queries are lazy").
function MinerSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  // False when the column isn't on the database yet. A different thing from a
  // failed read, and the difference is "apply the migration" vs "something is
  // broken", so they get different messages.
  const [available, setAvailable] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('ai_draft_miner_enabled')
      .eq('id', 1)
      .maybeSingle()
    if (error) {
      if (error.code === UNDEFINED_COLUMN) { setAvailable(false); return }
      setLoadError(error.message)
      return
    }
    // Fail-closed: anything that isn't exactly true reads as off, matching the
    // edge function's own `=== true` gate.
    setEnabled((data as { ai_draft_miner_enabled?: boolean } | null)?.ai_draft_miner_enabled === true)
  }

  async function change(next: boolean) {
    if (enabled === null || saving || next === enabled) return
    if (next) {
      const ok = window.confirm(
        'Let the edit-miner file suggestions?\n\n' +
        'It won’t start on its own — there’s no scheduled job for it yet, so nothing happens until someone runs the miner.\n\n' +
        'When it is run, each run costs roughly $0.75–$1 of Opus 5 calls, on the same API key the live drafting uses — and it keeps no record of where it got to, so every run pays for the same window again.\n\n' +
        'Nothing it files reaches the live briefing until you approve it.',
      )
      if (!ok) return
    }
    const prev = enabled
    setEnabled(next)
    setSaving(true)
    setSaveError(null)
    const { error } = await supabase
      .from('settings')
      .update({ ai_draft_miner_enabled: next, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setSaving(false)
    if (error) { setEnabled(prev); setSaveError(error.message); return }
    void logAudit({
      action: 'setting.ai_draft_miner_enabled_updated',
      targetType: 'setting',
      targetId: 'ai_draft_miner_enabled',
      targetLabel: 'Edit-miner may file suggestions',
      beforeValue: { ai_draft_miner_enabled: prev },
      afterValue: { ai_draft_miner_enabled: next },
    })
  }

  // What the switch is doing right now, in the same words the copy uses. An
  // absent column and an unreadable one both read as "dry run only" because
  // that is exactly how the miner itself treats them — it is not a guess.
  const stateLabel =
    enabled === true ? 'armed'
    : enabled === false ? 'dry run only'
    : available && !loadError ? 'checking…'
    : 'dry run only'

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-ink">Let the miner file suggestions</h2>
            {saving && <span className="text-[11px] text-ink-dim">Saving…</span>}
          </div>
          <p className="text-xs text-ink-mute max-w-2xl">
            The edit-miner is what fills this queue: it reads the draft ledger, works out what the team keeps changing,
            and files what it finds here. Off — a run still reports what it <em>would</em> file, but writes nothing.
            On — a run may file. Either way, approving a proposal is still the only thing that reaches the live briefing.
          </p>
          <p className="text-xs text-ink-mute max-w-2xl">
            <span className="text-ink">Nothing runs on a schedule.</span> There’s no timed job for the miner yet, so
            turning this on doesn’t start anything by itself — the miner still has to be run before a suggestion appears.
          </p>
          <p className="text-xs text-ink-mute max-w-2xl">
            <span className="text-ink">Each run costs real money.</span> About six calls to Opus 5 at roughly 25,000
            input tokens each — in the region of $0.75–$1 a run before output — on the same API key the live drafting
            uses. It keeps no record of where it last got to, so every run re-reads the same window and pays for it again.
          </p>
          {!available && (
            <p className="text-xs text-ink-mute max-w-2xl">
              <span className="text-ink">Not available until the database migration is applied.</span> The setting this
              switch writes isn’t on the database yet, so there’s nothing to turn on. Until it is, every miner run is a
              dry run: it reports what it would file and writes nothing.
            </p>
          )}
          {loadError && (
            <p className="text-xs text-[var(--c-out)]">Couldn’t read the setting: {loadError}</p>
          )}
          {saveError && (
            <p className="text-xs text-[var(--c-out)]">Save failed: {saveError}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Pill colour={enabled === true ? 'in-stock' : 'mute'}>{stateLabel}</Pill>
          <Toggle
            value={enabled === true}
            onChange={(v) => void change(v)}
            disabled={!available || enabled === null || saving}
            label="Let the edit-miner file suggestions"
          />
        </div>
      </div>
    </div>
  )
}

// Fetch the current text of every briefing entry the loaded proposals point at.
// At most two small extra queries; a failure costs the before/after panel only,
// never the page.
async function loadTargets(rows: Proposal[]): Promise<Targets> {
  const ruleIds = [...new Set(rows.map((p) => p.target_rule_id).filter((x): x is string => !!x))]
  const exemplarIds = [...new Set(rows.map((p) => p.target_exemplar_id).filter((x): x is string => !!x))]
  if (ruleIds.length === 0 && exemplarIds.length === 0) return { rules: {}, exemplars: {}, loaded: true }

  const rules: Record<string, TargetRule> = {}
  const exemplars: Record<string, TargetExemplar> = {}
  let ok = true

  if (ruleIds.length > 0) {
    const { data, error } = await supabase
      .from('ai_draft_house_rules').select('id, rule_text, is_active').in('id', ruleIds)
    if (error) ok = false
    else for (const row of (data ?? []) as TargetRule[]) rules[row.id] = row
  }
  if (exemplarIds.length > 0) {
    const { data, error } = await supabase
      .from('ai_draft_exemplars').select('id, category, customer_text, reply_text, is_active').in('id', exemplarIds)
    if (error) ok = false
    else for (const row of (data ?? []) as TargetExemplar[]) exemplars[row.id] = row
  }
  return { rules, exemplars, loaded: ok }
}

function ProposalCard({ p, targets, hasExemplarTarget, working, onDecide }: { p: Proposal; targets: Targets; hasExemplarTarget: boolean; working: boolean; onDecide: (p: Proposal, d: 'approved' | 'rejected') => void }) {
  const isFlag = p.kind === 'category_flag'
  const isRetire = p.kind === 'house_rule_retire' || p.kind === 'exemplar_retire'
  const isExemplarEdit = p.kind === 'exemplar_edit'

  // Which briefing entry this proposal changes, if any. A retire or an edit
  // always names one; adds and flags don't.
  const needsRule = NEEDS_TARGET_RULE.includes(p.kind)
  const needsExemplar = NEEDS_TARGET_EXEMPLAR.includes(p.kind)
  const targetRuleId = needsRule ? p.target_rule_id : null
  const targetExemplarId = needsExemplar ? p.target_exemplar_id : null
  const rule = targetRuleId ? targets.rules[targetRuleId] : undefined
  const exemplar = targetExemplarId ? targets.exemplars[targetExemplarId] : undefined
  // Only complain about a broken pointer once we know the lookup actually ran.
  const targetMissing = targets.loaded && ((targetRuleId != null && !rule) || (targetExemplarId != null && !exemplar))
  const targetRetired = (rule && !rule.is_active) || (exemplar && !exemplar.is_active)

  // What the proposal really supplies, judged the same way the database judges
  // it, so the card can't promise a change the database is going to ignore.
  const proposedText = supplied(p.proposed_text)
  const proposedCustomer = supplied(p.proposed_customer_text)
  const proposedCategory = supplied(p.category)

  // Why approving would fail, when it plainly would. This is worked out from
  // the proposal row alone — unlike the two warnings further down it can't be
  // out of date, so Approve is switched off rather than merely cautioned
  // against. An edit or a removal that never says WHICH entry it means is the
  // first thing likely to go wrong in a machine-written proposal, and until now
  // it looked like an ordinary edit card: no before/after panel, no warning,
  // Approve live, and a raw database error on the click.
  let blocker: string | null = null
  if (needsRule && !p.target_rule_id) {
    blocker = 'This doesn’t say which rule it means, so there’s nothing to change. Reject it.'
  } else if (needsExemplar && !p.target_exemplar_id) {
    // Two very different reasons the pointer can be empty, and telling them
    // apart is the difference between "reject this" and "apply the migration".
    blocker = hasExemplarTarget
      ? 'This doesn’t say which example it means, so there’s nothing to change. Reject it.'
      : 'The database doesn’t yet have the field that records which example a proposal changes, so this can’t be applied. It needs the database migration — don’t reject it on this account.'
  } else if (NEEDS_PROPOSED_TEXT.includes(p.kind) && !proposedText) {
    blocker = 'No wording was supplied, so there’s nothing to put in the briefing. Reject it.'
  } else if (isExemplarEdit && !proposedText && !proposedCustomer && !proposedCategory) {
    blocker = 'This doesn’t say what to change about the example. Reject it.'
  }

  // Read off the briefing as it stood when the page loaded. Someone may have
  // put the entry back in another tab since, so these caution rather than block.
  const warning = blocker ? null
    : targetMissing ? 'The briefing entry this points at no longer exists, so this proposal can’t be applied. Reject it.'
    : targetRetired ? 'That entry has already been removed from the briefing, so approving this will fail. Reject it, or restore the entry on the Briefing tab first.'
    : null

  const boxCls = 'whitespace-pre-wrap font-sans text-sm bg-canvas border border-line-soft rounded-[8px] p-3 leading-relaxed'

  return (
    <div className="rounded-lg border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill colour={KIND_PILL[p.kind]}>{KIND_LABEL[p.kind]}</Pill>
        {proposedCategory && <Pill colour="mute">{proposedCategory}</Pill>}
        <Pill colour={STATUS_PILL[p.status]}>{p.status}</Pill>
        {p.recurrence_count > 0 && <span className="text-xs text-ink-dim">seen in {p.recurrence_count} conversation{p.recurrence_count === 1 ? '' : 's'}</span>}
        {p.reviewer_disagreement && <Pill colour="low">team disagreed</Pill>}
        <span className="ml-auto text-xs text-ink-dim">{new Date(p.created_at).toLocaleDateString('en-GB')}</span>
      </div>

      <div>
        <div className="eyebrow text-ink-mute mb-1">Why</div>
        <p className="text-sm text-ink">{p.rationale}</p>
      </div>

      {/* What's in the briefing today, so an edit or a removal reads as a
          before/after rather than an unanchored paragraph. */}
      {rule && (
        <div>
          <div className="eyebrow text-ink-mute mb-1">{isRetire ? 'Which rule' : 'Rule today'}</div>
          <pre className={`${boxCls} text-ink-mute`}>{rule.rule_text}</pre>
        </div>
      )}
      {exemplar && (
        <div>
          <div className="eyebrow text-ink-mute mb-1">{isRetire ? 'Which example' : 'Example today'}</div>
          <div className={`${boxCls} text-ink-mute`}>
            <p className="text-ink-dim text-xs mb-0.5">Customer wrote:</p>
            <p className="mb-2">{exemplar.customer_text}</p>
            <p className="text-ink-dim text-xs mb-0.5">We replied:</p>
            <p>{exemplar.reply_text}</p>
          </div>
        </div>
      )}
      {/* Only actionable while the proposal is still pending. */}
      {(blocker ?? warning) && p.status === 'pending' && (
        <p className="text-xs text-[var(--c-out)]">{blocker ?? warning}</p>
      )}

      {/* A removal has no proposed text — say plainly what approving does
          instead of rendering an empty box. Suppressed when it can't be
          approved at all, so the card doesn't describe and forbid in one breath. */}
      {isRetire && !blocker && p.status === 'pending' && (
        <p className="text-sm text-ink">
          Approving takes this out of the briefing, so the AI stops using it. It isn’t deleted — you can put it back with Restore on the Briefing tab.
        </p>
      )}

      {!isFlag && !isRetire && proposedText && (
        <div>
          <div className="eyebrow text-ink-mute mb-1">{PROPOSED_LABEL[p.kind]}</div>
          {(p.kind === 'exemplar_add' || isExemplarEdit) && proposedCustomer && (
            <p className="text-xs text-ink-mute whitespace-pre-wrap mb-2 bg-canvas border border-line-soft rounded-[8px] p-2">Customer: {proposedCustomer}</p>
          )}
          <pre className={`${boxCls} text-ink`}>{proposedText}</pre>
          {isExemplarEdit && !proposedCustomer && (
            <p className="text-xs text-ink-dim mt-1">The customer message stays as it is — only the reply changes.</p>
          )}
        </div>
      )}
      {isExemplarEdit && !proposedText && proposedCustomer && (
        <div>
          <div className="eyebrow text-ink-mute mb-1">Proposed customer message</div>
          <pre className={`${boxCls} text-ink`}>{proposedCustomer}</pre>
          <p className="text-xs text-ink-dim mt-1">The reply stays as it is — only the customer message changes.</p>
        </div>
      )}
      {/* The category on a proposal is usually just context, and matches what's
          already stored. When it doesn't, approving re-files the example. An
          edit is allowed to carry ONLY a new category, and if the before/after
          panel is absent too (entry gone, or the lookup failed) the card would
          otherwise show a rationale and an Approve button with nothing at all
          saying what approving does. */}
      {isExemplarEdit && !blocker && proposedCategory && (
        <CategoryNote
          proposed={proposedCategory}
          current={exemplar?.category}
          textChanges={!!proposedText || !!proposedCustomer}
        />
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
          {/* Approve is off when we can prove it would fail; Reject always works,
              because rejecting a broken proposal is exactly what you want to do. */}
          <ButtonInk onClick={() => onDecide(p, 'approved')} disabled={working || blocker != null}>{working ? '…' : isFlag ? 'Acknowledge' : isRetire ? 'Approve & remove' : 'Approve'}</ButtonInk>
          <ButtonGhost onClick={() => onDecide(p, 'rejected')} disabled={working}>{isFlag ? 'Dismiss' : 'Reject'}</ButtonGhost>
        </div>
      )}
      {p.status !== 'pending' && p.decision_note && <p className="text-xs text-ink-dim">Note: {p.decision_note}</p>}
    </div>
  )
}

// One line saying what a category change on an example actually does. Kept
// separate because there are three honest answers depending on what we can see:
// we know the example and the category is different (a re-file), we know it and
// it's the same (nothing visible happens), or we can't see the example at all
// and can only state where it's being filed.
function CategoryNote({ proposed, current, textChanges }: { proposed: string; current?: string; textChanges: boolean }) {
  if (current === proposed) {
    // Approving still stamps the example as coming from this proposal, but the
    // reviewer would see no difference — say so rather than imply a change.
    return textChanges ? null : (
      <p className="text-xs text-ink-dim">
        Nothing visible changes — this example is already filed under <strong>{proposed}</strong>.
      </p>
    )
  }
  if (current) {
    return (
      <p className="text-xs text-ink-dim">
        This {textChanges ? 'also ' : ''}moves the example from the <strong>{current}</strong> category to <strong>{proposed}</strong>.
      </p>
    )
  }
  return (
    <p className="text-xs text-ink-dim">
      {textChanges
        ? <>This also files the example under <strong>{proposed}</strong>.</>
        : <>Only the category changes: approving files this example under <strong>{proposed}</strong>.</>}
    </p>
  )
}
