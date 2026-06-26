import { useEffect, useState } from 'react'
import { Plus, MessageSquarePlus, ImageIcon, Trash2 } from 'lucide-react'
import { DesignerChrome, ButtonCoral, ButtonGhost, ButtonInk, Pill, Textarea } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import FeedbackModal from '../components/FeedbackModal'
import FeedbackStatusPill from '../components/FeedbackStatusPill'
import {
  FEEDBACK_BUCKET,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
  FEEDBACK_PRIORITIES,
  FEEDBACK_PRIORITY_META,
  authorBadgeColour,
  type FeedbackItem,
  type FeedbackStatus,
  type FeedbackType,
  type FeedbackPriority,
} from '../lib/feedback'

type StatusFilter = FeedbackStatus | 'all'
type TypeFilter = FeedbackType | 'all'
type PriorityFilter = FeedbackPriority | 'all'

// Small initials badge matching a staffer's header avatar colour.
function AuthorBadge({ initials, colour }: { initials: string | null; colour: string | null }) {
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-medium text-white"
      style={{ backgroundColor: authorBadgeColour(colour) }}
      aria-hidden="true"
    >
      {(initials ?? '?').slice(0, 2)}
    </span>
  )
}

export default function FeedbackPage() {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'

  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [mineOnly, setMineOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase
        .from('feedback_items')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500)
      if (cancelled) return
      if (error) {
        setLoadError(true)
        setLoading(false)
        return
      }
      setItems((data ?? []) as FeedbackItem[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = items.filter((it) => {
    if (statusFilter !== 'all' && it.status !== statusFilter) return false
    if (typeFilter !== 'all' && it.type !== typeFilter) return false
    if (priorityFilter !== 'all' && it.priority !== priorityFilter) return false
    if (mineOnly && it.created_by !== userId) return false
    return true
  })

  // Open count for the heading — anything not finished.
  const openCount = items.filter((it) => it.status !== 'done' && it.status !== 'wont_do').length

  function handleCreated(item: FeedbackItem) {
    setItems((prev) => [item, ...prev])
    setModalOpen(false)
  }

  // Admin: persist a status / priority / note change + keep local state in sync.
  async function saveTriage(
    item: FeedbackItem,
    status: FeedbackStatus,
    priority: FeedbackPriority,
    adminNote: string,
  ) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle()
    const changerName = (prof?.full_name as string | null) ?? null
    const nowIso = new Date().toISOString()
    const patch = {
      status,
      priority,
      admin_note: adminNote.trim() || null,
      status_changed_at: nowIso,
      status_changed_by: userId,
      status_changed_by_name: changerName,
      updated_at: nowIso,
    }
    const { error } = await supabase.from('feedback_items').update(patch).eq('id', item.id)
    if (error) return false
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...patch } : it)))
    void logAudit({
      action: 'feedback.status_changed',
      targetType: 'feedback',
      targetId: item.id,
      targetLabel: item.title,
      beforeValue: { status: item.status, priority: item.priority },
      afterValue: { status, priority },
    })
    return true
  }

  async function deleteItem(item: FeedbackItem) {
    if (!window.confirm('Delete this feedback? This cannot be undone.')) return
    if (item.attachment_paths.length > 0) {
      await supabase.storage.from(FEEDBACK_BUCKET).remove(item.attachment_paths)
    }
    const { error } = await supabase.from('feedback_items').delete().eq('id', item.id)
    if (error) {
      window.alert(`Could not delete: ${error.message}`)
      return
    }
    setItems((prev) => prev.filter((it) => it.id !== item.id))
    void logAudit({
      action: 'feedback.deleted',
      targetType: 'feedback',
      targetId: item.id,
      targetLabel: item.title,
    })
  }

  return (
    <DesignerChrome
      active="feedback"
      actions={
        <ButtonCoral icon={Plus} onClick={() => setModalOpen(true)} className="max-md:hidden">
          New feedback
        </ButtonCoral>
      }
    >
      <main className="mx-auto max-w-[900px] px-4 py-8 sm:px-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-ink">Feedback</h1>
            <p className="mt-1 text-sm text-ink-soft">
              Bugs and ideas from the team. Anyone can post; Rob works through them and updates the status.
            </p>
          </div>
          {/* Mobile-friendly primary action (the header CTA is hidden < md). */}
          <ButtonCoral icon={Plus} onClick={() => setModalOpen(true)} className="md:hidden shrink-0">
            New
          </ButtonCoral>
        </div>

        {/* Filters — compact dropdowns rather than a wall of pills. */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <FilterSelect
            allLabel="All statuses"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={FEEDBACK_STATUSES}
          />
          <FilterSelect
            allLabel="All types"
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as TypeFilter)}
            options={FEEDBACK_TYPES}
          />
          <FilterSelect
            allLabel="All priorities"
            value={priorityFilter}
            onChange={(v) => setPriorityFilter(v as PriorityFilter)}
            options={FEEDBACK_PRIORITIES}
          />
          <FilterChip active={mineOnly} onClick={() => setMineOnly((v) => !v)}>
            Mine
          </FilterChip>
          <span className="ml-auto text-[12px] text-ink-mute">
            {openCount} open · {items.length} total
          </span>
        </div>

        {/* List */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-ink-mute">Loading feedback…</p>
          ) : loadError ? (
            <div className="rounded-[14px] border border-dashed border-line bg-canvas px-6 py-12 text-center">
              <p className="text-sm text-out">Couldn’t load feedback — please reload the page.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-line bg-canvas px-6 py-12 text-center">
              <MessageSquarePlus size={28} className="mx-auto text-ink-dim" aria-hidden="true" />
              <p className="mt-3 text-sm text-ink-soft">
                {items.length === 0
                  ? 'No feedback yet — be the first to share a bug or an idea.'
                  : 'Nothing matches these filters.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((it) => (
                <FeedbackCard
                  key={it.id}
                  item={it}
                  isAdmin={isAdmin}
                  canDelete={isAdmin || it.created_by === userId}
                  onSaveTriage={saveTriage}
                  onDelete={deleteItem}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {modalOpen && <FeedbackModal onClose={() => setModalOpen(false)} onCreated={handleCreated} />}
    </DesignerChrome>
  )
}

// Compact dropdown filter (status / type / priority). 'all' is the first
// option; the rest come from the feedback metadata. Uses the app's
// select-styled chevron so it matches every other styled select.
function FilterSelect({
  allLabel,
  value,
  onChange,
  options,
}: {
  allLabel: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="select-styled h-8 rounded-full border border-line bg-surface pl-3 text-[13px] text-ink-soft transition-colors hover:bg-canvas focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
    >
      <option value="all">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'h-8 rounded-full border px-3 text-[13px] transition-colors',
        active
          ? 'border-ink bg-ink text-on-ink'
          : 'border-line bg-surface text-ink-mute hover:bg-canvas hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function FeedbackCard({
  item,
  isAdmin,
  canDelete,
  onSaveTriage,
  onDelete,
}: {
  item: FeedbackItem
  isAdmin: boolean
  canDelete: boolean
  onSaveTriage: (
    item: FeedbackItem,
    status: FeedbackStatus,
    priority: FeedbackPriority,
    note: string,
  ) => Promise<boolean>
  onDelete: (item: FeedbackItem) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [signedUrls, setSignedUrls] = useState<string[] | null>(null)
  const [statusDraft, setStatusDraft] = useState<FeedbackStatus>(item.status)
  const [priorityDraft, setPriorityDraft] = useState<FeedbackPriority>(item.priority)
  const [noteDraft, setNoteDraft] = useState(item.admin_note ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // Re-seed the admin drafts if the underlying item changes (e.g. after a save).
  useEffect(() => {
    setStatusDraft(item.status)
    setPriorityDraft(item.priority)
    setNoteDraft(item.admin_note ?? '')
  }, [item.status, item.priority, item.admin_note])

  // Generate signed URLs for the screenshots the first time the card opens.
  useEffect(() => {
    if (!expanded || signedUrls !== null || item.attachment_paths.length === 0) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase.storage
        .from(FEEDBACK_BUCKET)
        .createSignedUrls(item.attachment_paths, 3600)
      if (cancelled) return
      setSignedUrls((data ?? []).map((d) => d.signedUrl).filter((u): u is string => !!u))
    })()
    return () => {
      cancelled = true
    }
  }, [expanded, signedUrls, item.attachment_paths])

  const typeMeta = FEEDBACK_TYPE_META[item.type]
  const priorityMeta = FEEDBACK_PRIORITY_META[item.priority]
  const dirty =
    statusDraft !== item.status ||
    priorityDraft !== item.priority ||
    (noteDraft.trim() || null) !== (item.admin_note ?? null)

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setSaveError(false)
    const ok = await onSaveTriage(item, statusDraft, priorityDraft, noteDraft)
    setSaving(false)
    if (ok) {
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } else {
      setSaveError(true)
    }
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-canvas"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill colour={typeMeta.colour}>{typeMeta.label}</Pill>
            <FeedbackStatusPill status={item.status} />
            <Pill colour={priorityMeta.colour}>{priorityMeta.label}</Pill>
            <span className="text-[15px] font-medium text-ink">{item.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-mute">
            <AuthorBadge initials={item.created_by_initials} colour={item.created_by_colour} />
            <span>{item.created_by_name ?? 'Someone'}</span>
            <span aria-hidden="true">·</span>
            <span title={formatAbsoluteDateTime(item.created_at)}>{relativeTime(item.created_at)}</span>
            {item.area && (
              <>
                <span aria-hidden="true">·</span>
                <span>{item.area}</span>
              </>
            )}
            {item.attachment_paths.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <ImageIcon size={12} aria-hidden="true" />
                  {item.attachment_paths.length}
                </span>
              </>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line-soft px-4 py-4">
          {item.body && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{item.body}</p>
          )}

          {item.attachment_paths.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {signedUrls === null
                ? item.attachment_paths.map((_, i) => (
                    <div key={i} className="h-24 animate-pulse rounded-lg bg-canvas" />
                  ))
                : signedUrls.map((url, i) => (
                    <a
                      key={i}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block overflow-hidden rounded-lg border border-line hover:opacity-90"
                    >
                      <img src={url} alt={`Screenshot ${i + 1}`} className="h-24 w-full object-cover" />
                    </a>
                  ))}
            </div>
          )}

          {/* Triage note — shown to everyone once Rob's written one. */}
          {item.admin_note && !isAdmin && (
            <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Note</span>
              {item.admin_note}
            </div>
          )}

          {item.status_changed_at && (
            <p className="mt-3 text-[12px] text-ink-mute">
              Status updated {relativeTime(item.status_changed_at)}
              {item.status_changed_by_name ? ` by ${item.status_changed_by_name}` : ''}
            </p>
          )}

          {/* Admin triage controls */}
          {isAdmin && (
            <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
              <span className="eyebrow mb-2 block">Triage</span>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="flex gap-2 sm:w-44 sm:shrink-0 sm:flex-col">
                  <label className="block flex-1 sm:flex-none">
                    <span className="sr-only">Status</span>
                    <select
                      value={statusDraft}
                      onChange={(e) => setStatusDraft(e.target.value as FeedbackStatus)}
                      className="select-styled h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                    >
                      {FEEDBACK_STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block flex-1 sm:flex-none">
                    <span className="sr-only">Priority</span>
                    <select
                      value={priorityDraft}
                      onChange={(e) => setPriorityDraft(e.target.value as FeedbackPriority)}
                      className="select-styled h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                    >
                      {FEEDBACK_PRIORITIES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={2}
                  placeholder="Add a note (optional) — shown to everyone."
                  className="flex-1"
                />
              </div>
              <div className="mt-2 flex items-center justify-end gap-2">
                {saveError && (
                  <span role="alert" className="text-[12px] text-out">
                    Couldn’t save — please try again
                  </span>
                )}
                {saved && !saveError && <span className="text-[12px] text-in-stock">✓ Saved</span>}
                <ButtonInk size="sm" onClick={handleSave} busy={saving} disabled={!dirty}>
                  Save
                </ButtonInk>
              </div>
            </div>
          )}

          {canDelete && (
            <div className="mt-3 flex justify-end">
              <ButtonGhost size="sm" icon={Trash2} onClick={() => onDelete(item)}>
                Delete
              </ButtonGhost>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
