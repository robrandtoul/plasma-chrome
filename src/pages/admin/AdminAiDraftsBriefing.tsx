import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { Pill, ButtonInk, ButtonGhost } from '../../design'

// Phase 3b — the editable briefing. The 38 house rules + 8 example replies that
// teach the AI drafter Plasma's facts and voice now live in the DB
// (proofs.ai_draft_house_rules / ai_draft_exemplars, migration 000225), so they
// can be tuned here without a code change or redeploy. The drafter reads them on
// the next email and falls back to the compiled constants if the DB is ever
// unreadable (briefing.ts).
//
// Same direct-supabase + per-change audit pattern as the other catalogue
// editors (AdminCoreColoursPage). Remove is a soft delete (is_active=false) so
// a rule can be restored, and so an approved proposal's provenance survives.

interface Rule {
  id: string
  sort_order: number
  rule_text: string
  is_active: boolean
  source: string
}
interface Exemplar {
  id: string
  sort_order: number
  category: string
  customer_text: string
  reply_text: string
  is_active: boolean
  source: string
}

const SOURCE_PILL = (s: string) => (s === 'proposal' ? 'allocated' : s === 'manual' ? 'neutral' : 'mute')

export default function AdminAiDraftsBriefing() {
  const [rules, setRules] = useState<Rule[]>([])
  const [exemplars, setExemplars] = useState<Exemplar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const [r, e] = await Promise.all([
      supabase.from('ai_draft_house_rules').select('id, sort_order, rule_text, is_active, source').order('sort_order'),
      supabase.from('ai_draft_exemplars').select('id, sort_order, category, customer_text, reply_text, is_active, source').order('sort_order'),
    ])
    if (r.error) { setError(r.error.message); setLoading(false); return }
    if (e.error) { setError(e.error.message); setLoading(false); return }
    setRules((r.data ?? []) as Rule[])
    setExemplars((e.data ?? []) as Exemplar[])
    setLoading(false)
  }

  if (loading) return <p className="text-ink-mute text-sm">Loading briefing…</p>
  if (error) return <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink"><span className="text-[var(--c-out)]">Couldn’t load:</span> {error}</div>

  return (
    <div className="space-y-8">
      <p className="text-sm text-ink-mute -mt-2">
        These are the facts and the example replies the AI follows. Edits take effect on the next email — no deploy.
        The safety guardrails (supplier secrecy, approved links, tone) are not editable here.
      </p>

      <RulesEditor rules={rules} setRules={setRules} />
      <ExemplarsEditor exemplars={exemplars} setExemplars={setExemplars} />
    </div>
  )
}

// ── House rules ──────────────────────────────────────────────────────────────

function RulesEditor({ rules, setRules }: { rules: Rule[]; setRules: React.Dispatch<React.SetStateAction<Rule[]>> }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newText, setNewText] = useState('')

  function startEdit(r: Rule) { setEditingId(r.id); setDraftText(r.rule_text); setRowError(null) }

  async function saveEdit(r: Rule) {
    const text = draftText.trim()
    if (!text) { setRowError('Rule text is required.'); return }
    if (text === r.rule_text) { setEditingId(null); return }
    setSaving(true); setRowError(null)
    const { data, error } = await supabase
      .from('ai_draft_house_rules')
      .update({ rule_text: text, source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', r.id).select('id, sort_order, rule_text, is_active, source').single()
    setSaving(false)
    if (error || !data) { setRowError(error?.message ?? 'Save failed.'); return }
    setRules((prev) => prev.map((x) => (x.id === r.id ? (data as Rule) : x)))
    setEditingId(null)
    void logAudit({ action: 'ai_draft_house_rule.updated', targetType: 'ai_draft_house_rule', targetId: r.id, beforeValue: { rule_text: r.rule_text }, afterValue: { rule_text: text } })
  }

  async function toggleActive(r: Rule) {
    const next = !r.is_active
    const { data, error } = await supabase.from('ai_draft_house_rules').update({ is_active: next, updated_at: new Date().toISOString() }).eq('id', r.id).select('id, sort_order, rule_text, is_active, source').single()
    if (error || !data) return
    setRules((prev) => prev.map((x) => (x.id === r.id ? (data as Rule) : x)))
    void logAudit({ action: next ? 'ai_draft_house_rule.reactivated' : 'ai_draft_house_rule.deactivated', targetType: 'ai_draft_house_rule', targetId: r.id, afterValue: { is_active: next } })
  }

  async function addRule() {
    const text = newText.trim()
    if (!text) { setRowError('Rule text is required.'); return }
    setSaving(true); setRowError(null)
    const nextSort = rules.reduce((m, x) => Math.max(m, x.sort_order), 0) + 1
    const { data, error } = await supabase.from('ai_draft_house_rules').insert({ sort_order: nextSort, rule_text: text, source: 'manual' }).select('id, sort_order, rule_text, is_active, source').single()
    setSaving(false)
    if (error || !data) { setRowError(error?.message ?? 'Save failed.'); return }
    setRules((prev) => [...prev, data as Rule])
    setAdding(false); setNewText('')
    void logAudit({ action: 'ai_draft_house_rule.created', targetType: 'ai_draft_house_rule', targetId: (data as Rule).id, afterValue: { rule_text: text } })
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">House rules <span className="text-ink-dim font-normal">({rules.filter((r) => r.is_active).length} active)</span></h2>
        <ButtonGhost onClick={() => { setAdding(true); setNewText('') }} disabled={adding}>+ Add rule</ButtonGhost>
      </div>

      {adding && (
        <div className="rounded-lg border border-line bg-canvas p-3 space-y-2">
          <textarea value={newText} onChange={(e) => { setNewText(e.target.value); setRowError(null) }} rows={3} placeholder="A new fact or policy the AI must follow…" className="w-full rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none" />
          {rowError && <p className="text-xs text-[var(--c-out)]">{rowError}</p>}
          <div className="flex gap-2"><ButtonInk onClick={() => void addRule()} disabled={saving}>{saving ? 'Saving…' : 'Add rule'}</ButtonInk><ButtonGhost onClick={() => { setAdding(false); setRowError(null) }} disabled={saving}>Cancel</ButtonGhost></div>
        </div>
      )}

      <ol className="space-y-2">
        {rules.map((r, i) => {
          const isEditing = editingId === r.id
          return (
            <li key={r.id} className={['rounded-lg border border-line p-3', r.is_active ? 'bg-surface' : 'bg-canvas'].join(' ')}>
              <div className="flex items-start gap-3">
                <span className="text-xs text-ink-dim tabular-nums pt-0.5 w-6 shrink-0">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <textarea value={draftText} onChange={(e) => { setDraftText(e.target.value); setRowError(null) }} rows={4} className="w-full rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none" />
                  ) : (
                    <p className={['text-sm whitespace-pre-wrap', r.is_active ? 'text-ink' : 'text-ink-mute'].join(' ')}>{r.rule_text}</p>
                  )}
                  {isEditing && rowError && <p className="text-xs text-[var(--c-out)] mt-1">{rowError}</p>}
                  <div className="flex items-center gap-2 mt-2">
                    {r.source !== 'seed' && <Pill colour={SOURCE_PILL(r.source)}>{r.source}</Pill>}
                    {!r.is_active && <Pill colour="mute">inactive</Pill>}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  {isEditing ? (
                    <>
                      <ButtonInk onClick={() => void saveEdit(r)} disabled={saving}>{saving ? '…' : 'Save'}</ButtonInk>
                      <ButtonGhost onClick={() => { setEditingId(null); setRowError(null) }} disabled={saving}>Cancel</ButtonGhost>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(r)} className="rounded px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-canvas">Edit</button>
                      <button onClick={() => void toggleActive(r)} className={['rounded px-2.5 py-1 text-xs font-medium', r.is_active ? 'text-[var(--c-out)] hover:bg-out-soft' : 'text-in-stock hover:bg-in-stock-soft'].join(' ')}>{r.is_active ? 'Remove' : 'Restore'}</button>
                    </>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ── Exemplars ────────────────────────────────────────────────────────────────

function ExemplarsEditor({ exemplars, setExemplars }: { exemplars: Exemplar[]; setExemplars: React.Dispatch<React.SetStateAction<Exemplar[]>> }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ category: string; customer: string; reply: string }>({ category: '', customer: '', reply: '' })
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newEx, setNewEx] = useState<{ category: string; customer: string; reply: string }>({ category: 'quote_request', customer: '', reply: '' })

  function startEdit(e: Exemplar) { setEditingId(e.id); setDraft({ category: e.category, customer: e.customer_text, reply: e.reply_text }); setRowError(null) }

  async function saveEdit(e: Exemplar) {
    if (!draft.reply.trim() || !draft.customer.trim() || !draft.category.trim()) { setRowError('Category, customer message and reply are all required.'); return }
    setSaving(true); setRowError(null)
    const { data, error } = await supabase.from('ai_draft_exemplars')
      .update({ category: draft.category.trim(), customer_text: draft.customer.trim(), reply_text: draft.reply.trim(), source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', e.id).select('id, sort_order, category, customer_text, reply_text, is_active, source').single()
    setSaving(false)
    if (error || !data) { setRowError(error?.message ?? 'Save failed.'); return }
    setExemplars((prev) => prev.map((x) => (x.id === e.id ? (data as Exemplar) : x)))
    setEditingId(null)
    void logAudit({ action: 'ai_draft_exemplar.updated', targetType: 'ai_draft_exemplar', targetId: e.id, afterValue: { category: draft.category } })
  }

  async function toggleActive(e: Exemplar) {
    const next = !e.is_active
    const { data, error } = await supabase.from('ai_draft_exemplars').update({ is_active: next, updated_at: new Date().toISOString() }).eq('id', e.id).select('id, sort_order, category, customer_text, reply_text, is_active, source').single()
    if (error || !data) return
    setExemplars((prev) => prev.map((x) => (x.id === e.id ? (data as Exemplar) : x)))
    void logAudit({ action: next ? 'ai_draft_exemplar.reactivated' : 'ai_draft_exemplar.deactivated', targetType: 'ai_draft_exemplar', targetId: e.id, afterValue: { is_active: next } })
  }

  async function addExemplar() {
    if (!newEx.reply.trim() || !newEx.customer.trim() || !newEx.category.trim()) { setRowError('Category, customer message and reply are all required.'); return }
    setSaving(true); setRowError(null)
    const nextSort = exemplars.reduce((m, x) => Math.max(m, x.sort_order), 0) + 1
    const { data, error } = await supabase.from('ai_draft_exemplars').insert({ sort_order: nextSort, category: newEx.category.trim(), customer_text: newEx.customer.trim(), reply_text: newEx.reply.trim(), source: 'manual' }).select('id, sort_order, category, customer_text, reply_text, is_active, source').single()
    setSaving(false)
    if (error || !data) { setRowError(error?.message ?? 'Save failed.'); return }
    setExemplars((prev) => [...prev, data as Exemplar])
    setAdding(false); setNewEx({ category: 'quote_request', customer: '', reply: '' })
    void logAudit({ action: 'ai_draft_exemplar.created', targetType: 'ai_draft_exemplar', targetId: (data as Exemplar).id, afterValue: { category: newEx.category } })
  }

  const fieldCls = 'w-full rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none'

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">Example replies <span className="text-ink-dim font-normal">({exemplars.filter((e) => e.is_active).length} active)</span></h2>
        <ButtonGhost onClick={() => { setAdding(true) }} disabled={adding}>+ Add example</ButtonGhost>
      </div>

      {adding && (
        <div className="rounded-lg border border-line bg-canvas p-3 space-y-2">
          <input value={newEx.category} onChange={(e) => { setNewEx({ ...newEx, category: e.target.value }); setRowError(null) }} placeholder="category (e.g. quote_request)" className={fieldCls} />
          <textarea value={newEx.customer} onChange={(e) => { setNewEx({ ...newEx, customer: e.target.value }); setRowError(null) }} rows={2} placeholder="Customer wrote…" className={fieldCls} />
          <textarea value={newEx.reply} onChange={(e) => { setNewEx({ ...newEx, reply: e.target.value }); setRowError(null) }} rows={5} placeholder="We replied…" className={fieldCls} />
          {rowError && <p className="text-xs text-[var(--c-out)]">{rowError}</p>}
          <div className="flex gap-2"><ButtonInk onClick={() => void addExemplar()} disabled={saving}>{saving ? 'Saving…' : 'Add example'}</ButtonInk><ButtonGhost onClick={() => { setAdding(false); setRowError(null) }} disabled={saving}>Cancel</ButtonGhost></div>
        </div>
      )}

      <ul className="space-y-3">
        {exemplars.map((e) => {
          const isEditing = editingId === e.id
          return (
            <li key={e.id} className={['rounded-lg border border-line p-3', e.is_active ? 'bg-surface' : 'bg-canvas'].join(' ')}>
              {isEditing ? (
                <div className="space-y-2">
                  <input value={draft.category} onChange={(ev) => { setDraft({ ...draft, category: ev.target.value }); setRowError(null) }} className={fieldCls} />
                  <textarea value={draft.customer} onChange={(ev) => { setDraft({ ...draft, customer: ev.target.value }); setRowError(null) }} rows={2} className={fieldCls} />
                  <textarea value={draft.reply} onChange={(ev) => { setDraft({ ...draft, reply: ev.target.value }); setRowError(null) }} rows={6} className={fieldCls} />
                  {rowError && <p className="text-xs text-[var(--c-out)]">{rowError}</p>}
                  <div className="flex gap-2"><ButtonInk onClick={() => void saveEdit(e)} disabled={saving}>{saving ? '…' : 'Save'}</ButtonInk><ButtonGhost onClick={() => { setEditingId(null); setRowError(null) }} disabled={saving}>Cancel</ButtonGhost></div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Pill colour="neutral">{e.category}</Pill>
                    {e.source !== 'seed' && <Pill colour={SOURCE_PILL(e.source)}>{e.source}</Pill>}
                    {!e.is_active && <Pill colour="mute">inactive</Pill>}
                    <div className="ml-auto flex items-center gap-1">
                      <button onClick={() => startEdit(e)} className="rounded px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-canvas">Edit</button>
                      <button onClick={() => void toggleActive(e)} className={['rounded px-2.5 py-1 text-xs font-medium', e.is_active ? 'text-[var(--c-out)] hover:bg-out-soft' : 'text-in-stock hover:bg-in-stock-soft'].join(' ')}>{e.is_active ? 'Remove' : 'Restore'}</button>
                    </div>
                  </div>
                  <div className={['text-sm', e.is_active ? 'text-ink' : 'text-ink-mute'].join(' ')}>
                    <p className="text-ink-dim text-xs mb-0.5">Customer wrote:</p>
                    <p className="whitespace-pre-wrap mb-2">{e.customer_text}</p>
                    <p className="text-ink-dim text-xs mb-0.5">We replied:</p>
                    <p className="whitespace-pre-wrap">{e.reply_text}</p>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
