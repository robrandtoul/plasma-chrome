import { useEffect, useState } from 'react'
import {
  Plus,
  MessageSquarePlus,
  ImageIcon,
  Trash2,
  Bug,
  Lightbulb,
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Archive,
} from 'lucide-react'
import {
  DesignerChrome,
  ButtonCoral,
  ButtonGhost,
  ButtonInk,
  Textarea,
  type PillColour,
} from '../design'
import { supabase } from '../lib/supabase'
import { useConfirm } from '../components/ConfirmDialog'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import FeedbackModal from '../components/FeedbackModal'
import FeedbackStatusPill from '../components/FeedbackStatusPill'
import {
  FEEDBACK_BUCKET,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
  FEEDBACK_PRIORITIES,
  FEEDBACK_RESOLVED_STATUSES,
  RECENTLY_SHIPPED_DAYS,
  authorBadgeColour,
  isUnseenResolved,
  isRecentlyShipped,
  isResolvedStatus,
  resolutionHeading,
  type FeedbackItem,
  type FeedbackStatus,
  type FeedbackType,
  type FeedbackPriority,
} from '../lib/feedback'

// The three lifecycle sections the board groups into. Status is the spine of
// the page: it lives in the section header (and Open work's sub-dividers), not
// as a per-card pill — so a colour on a card can only ever mean priority/type.
type FeedbackSection = 'open' | 'shipped' | 'parked'
type ScopeFilter = 'open' | 'all' | 'resolved'
type TypeFilter = FeedbackType | 'all'
type PriorityFilter = FeedbackPriority | 'all'
// 'smart' = grouped lifecycle sections; 'newest' = one flat newest-first list
// (restores the global-recency view, since status_changed_at only shows when a
// card is expanded).
type SortMode = 'smart' | 'newest'

const SECTION_OF: Record<FeedbackStatus, FeedbackSection> = {
  new: 'open',
  under_review: 'open',
  planned: 'open',
  in_progress: 'open',
  done: 'shipped',
  wont_do: 'parked',
}

const SECTIONS: { key: FeedbackSection; label: string }[] = [
  { key: 'open', label: 'Open work' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'parked', label: 'Parked' },
]

// Sub-status order inside Open work: active work surfaces at the top.
const OPEN_SUBSTATUS_ORDER: FeedbackStatus[] = ['in_progress', 'planned', 'under_review', 'new']

// High → Medium → Low for the priority sort inside a section.
const PRIORITY_RANK: Record<FeedbackPriority, number> = { high: 0, medium: 1, low: 2 }

const TYPE_ICON: Record<FeedbackType, typeof Bug> = {
  bug: Bug,
  idea: Lightbulb,
  improvement: Wrench,
}

// Solid dot colour per Pill colour, for the Open-work sub-divider markers.
const PILL_DOT: Record<PillColour, string> = {
  brand: 'var(--c-brand)',
  'in-stock': 'var(--c-in-stock)',
  low: 'var(--c-low)',
  out: 'var(--c-out)',
  critical: 'var(--c-critical)',
  allocated: 'var(--c-allocated)',
  neutral: 'var(--c-ink-mute, #8a8a8a)',
  mute: 'var(--c-ink-dim, #aaaaaa)',
}

function sectionInScope(section: FeedbackSection, scope: ScopeFilter): boolean {
  if (scope === 'all') return true
  if (scope === 'open') return section === 'open'
  return section === 'shipped' || section === 'parked'
}

function priorityRecencySort(a: FeedbackItem, b: FeedbackItem): number {
  const r = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  return r !== 0 ? r : b.created_at.localeCompare(a.created_at)
}

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
  const { confirm, alert: showAlert, dialog: confirmDialog } = useConfirm()
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'

  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [scope, setScope] = useState<ScopeFilter>('open')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [mineOnly, setMineOnly] = useState(false)
  const [sort, setSort] = useState<SortMode>('smart')
  // Section collapse: explicit user toggles override the scope-derived default.
  const [sectionOverrides, setSectionOverrides] = useState<Partial<Record<FeedbackSection, boolean>>>({})
  // Card expansion lives on the page (not per-card) so a card stays open after
  // an admin status change re-groups it into a different section.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  // The user's feedback_seen_at as it stood when this visit began — the
  // baseline for "new to you" highlighting. Captured before we re-stamp it,
  // so the highlights persist for the whole visit even as the header badge
  // clears for next time.
  const [seenBaseline, setSeenBaseline] = useState<string | null>(null)
  const [seenLoaded, setSeenLoaded] = useState(false)
  // The current user's OWN resolved items, fetched with the same scoped,
  // uncapped query the header badge uses (DesignerChrome) — so the "Resolved
  // for you" callout is built from the identical set the badge counts and the
  // two can never disagree, even if the 500-row board load drops an old-but-
  // recently-resolved item out of `items`.
  const [myResolved, setMyResolved] = useState<FeedbackItem[]>([])

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

  // Capture the seen baseline, then advance the stored marker to now(). Order
  // matters: we read the old value into state for this visit's highlighting,
  // then stamp so the header badge (computed in DesignerChrome) clears next
  // time. A failed stamp only means the badge lingers — harmless.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const [{ data: prof }, { data: mine }] = await Promise.all([
        supabase
          .from('profiles')
          .select('feedback_seen_at')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('feedback_items')
          .select('*')
          .eq('created_by', userId)
          .in('status', FEEDBACK_RESOLVED_STATUSES),
      ])
      if (cancelled) return
      setSeenBaseline((prof?.feedback_seen_at as string | null) ?? null)
      setMyResolved((mine ?? []) as FeedbackItem[])
      setSeenLoaded(true)
      // .then makes the lazy builder actually execute (see teamChatStore's
      // stampSeen note) — without it this stamp silently never persisted.
      void supabase
        .from('profiles')
        .update({ feedback_seen_at: new Date().toISOString() })
        .eq('id', userId)
        .then(({ error }) => {
          if (error) console.error('[feedback] seen stamp failed:', error.message)
        })
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  // Type / priority / mine filters (status scope is applied separately so the
  // section list and the "N showing" count share one predicate).
  function matchesFilters(it: FeedbackItem): boolean {
    if (typeFilter !== 'all' && it.type !== typeFilter) return false
    if (priorityFilter !== 'all' && it.priority !== priorityFilter) return false
    if (mineOnly && it.created_by !== userId) return false
    return true
  }

  const inScope = items.filter((it) => matchesFilters(it) && sectionInScope(SECTION_OF[it.status], scope))

  // Personal: the user's own items resolved since they last looked. Drives the
  // "resolved for you" callout + per-card "New" markers. Built from myResolved
  // (the scoped, uncapped fetch) — not the 500-row board load — so it always
  // matches the header badge. Gated on seenLoaded so nothing flashes before we
  // know the baseline. Newest-resolved first.
  const newToYou = seenLoaded
    ? myResolved
        .filter((it) => isUnseenResolved(it, userId, seenBaseline))
        .sort((a, b) => (b.status_changed_at ?? '').localeCompare(a.status_changed_at ?? ''))
    : []
  const newToYouIds = new Set(newToYou.map((it) => it.id))

  // Team momentum: anything shipped in the last RECENTLY_SHIPPED_DAYS, shown as
  // a band in the default Open view so shipped work isn't invisible there.
  // Respects the type/priority/mine filters; newest-shipped first.
  const recentlyShipped = items
    .filter((it) => matchesFilters(it) && isRecentlyShipped(it))
    .sort((a, b) => (b.status_changed_at ?? '').localeCompare(a.status_changed_at ?? ''))

  function defaultExpanded(section: FeedbackSection): boolean {
    if (section === 'open') return true
    return scope === 'resolved'
  }
  function isSectionExpanded(section: FeedbackSection): boolean {
    return sectionOverrides[section] ?? defaultExpanded(section)
  }
  function toggleSection(section: FeedbackSection) {
    setSectionOverrides((prev) => ({ ...prev, [section]: !isSectionExpanded(section) }))
  }
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    resolutionNote: string,
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
      resolution_note: resolutionNote.trim() || null,
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
    if (!(await confirm({
      title: 'Delete this feedback?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      confirmClass: 'bg-out text-white hover:opacity-90',
    }))) return
    if (item.attachment_paths.length > 0) {
      await supabase.storage.from(FEEDBACK_BUCKET).remove(item.attachment_paths)
    }
    const { error } = await supabase.from('feedback_items').delete().eq('id', item.id)
    if (error) {
      void showAlert(`Could not delete: ${error.message}`)
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

  function renderCard(
    it: FeedbackItem,
    showStatus: boolean,
    opts?: { resolutionInline?: boolean },
  ) {
    return (
      <FeedbackCard
        key={it.id}
        item={it}
        isAdmin={isAdmin}
        canDelete={isAdmin || it.created_by === userId}
        showStatus={showStatus}
        isNew={newToYouIds.has(it.id)}
        resolutionInline={opts?.resolutionInline ?? false}
        expanded={expandedIds.has(it.id)}
        onToggleExpand={() => toggleExpand(it.id)}
        onSaveTriage={saveTriage}
        onDelete={deleteItem}
      />
    )
  }

  // Grouped (smart) body: one block per in-scope, non-empty section.
  const groupedBody = SECTIONS.filter((s) => sectionInScope(s.key, scope)).map((section) => {
    const secItems = inScope.filter((it) => SECTION_OF[it.status] === section.key)
    if (secItems.length === 0) return null
    const expanded = isSectionExpanded(section.key)
    return (
      <section key={section.key}>
        <SectionHeader
          section={section.key}
          label={section.label}
          count={secItems.length}
          expanded={expanded}
          onToggle={() => toggleSection(section.key)}
        />
        {expanded &&
          (section.key === 'open' ? (
            <div className="space-y-1">
              {OPEN_SUBSTATUS_ORDER.map((status) => {
                const group = secItems
                  .filter((it) => it.status === status)
                  .sort(priorityRecencySort)
                if (group.length === 0) return null
                return (
                  <div key={status}>
                    <SubDivider status={status} count={group.length} />
                    <div className="space-y-3">{group.map((it) => renderCard(it, false))}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              {[...secItems]
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .map((it) => renderCard(it, false))}
            </div>
          ))}
      </section>
    )
  })

  // Flat (newest) body: one stream, newest first, status shown on each card.
  const flatBody = (
    <div className="space-y-3">
      {[...inScope]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((it) => renderCard(it, true))}
    </div>
  )

  return (
    <DesignerChrome
      active="feedback"
      actions={
        <ButtonCoral icon={Plus} onClick={() => setModalOpen(true)} className="max-md:hidden">
          New feedback
        </ButtonCoral>
      }
    >
      {confirmDialog}
      <main className="mx-auto w-full max-w-[900px] px-4 py-8 sm:px-7">
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

        {/* Personal loop-closer: the things YOU raised that have since been
            resolved, shown the moment you open the board (then cleared for
            next visit). Always visible regardless of the filters below. */}
        {newToYou.length > 0 && <ResolvedForYouCallout items={newToYou} />}

        {/* Filters — the primary axis is now the lifecycle scope (Open / All /
            Resolved) as ink pills; status itself drives the sections below, so
            it's no longer a per-card pill. Secondary axes stay as dropdowns. */}
        <div className="mt-6 rounded-[14px] border border-line bg-surface px-5 py-4">
          <div className="flex flex-wrap items-center gap-3 max-md:flex-nowrap max-md:overflow-x-auto">
            <span className="eyebrow pr-1 text-ink-mute max-md:shrink-0">Show</span>
            <FilterPill active={scope === 'open'} onClick={() => setScope('open')}>
              Open
            </FilterPill>
            <FilterPill active={scope === 'all'} onClick={() => setScope('all')}>
              All
            </FilterPill>
            <FilterPill active={scope === 'resolved'} onClick={() => setScope('resolved')}>
              Resolved
            </FilterPill>

            <span className="hidden flex-1 md:block" aria-hidden="true" />
            <span className="w-2 shrink-0 md:hidden" aria-hidden="true" />

            <span className="font-mono text-[12px] tabular-nums text-ink-mute max-md:shrink-0">
              {inScope.length} showing
            </span>
            <span className="h-4 w-px bg-line max-md:shrink-0" aria-hidden="true" />

            <FilterSelect
              label="Sort"
              className="max-md:shrink-0"
              value={sort}
              onChange={(v) => setSort(v as SortMode)}
              options={[
                { value: 'smart', label: 'Smart' },
                { value: 'newest', label: 'Newest' },
              ]}
            />
            <FilterSelect
              label="Type"
              className="max-md:shrink-0"
              value={typeFilter}
              onChange={(v) => setTypeFilter(v as TypeFilter)}
              options={[{ value: 'all', label: 'All' }, ...FEEDBACK_TYPES.map((t) => ({ value: t.value, label: t.label }))]}
            />
            <FilterSelect
              label="Priority"
              className="max-md:shrink-0"
              value={priorityFilter}
              onChange={(v) => setPriorityFilter(v as PriorityFilter)}
              options={[{ value: 'all', label: 'All' }, ...FEEDBACK_PRIORITIES.map((p) => ({ value: p.value, label: p.label }))]}
            />
            <FilterToggle active={mineOnly} onClick={() => setMineOnly((v) => !v)}>
              Mine
            </FilterToggle>
          </div>
        </div>

        {/* List */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-ink-mute">Loading feedback…</p>
          ) : loadError ? (
            <div className="rounded-[14px] border border-dashed border-line bg-canvas px-6 py-12 text-center">
              <p className="text-sm text-out">Couldn’t load feedback — please reload the page.</p>
            </div>
          ) : inScope.length === 0 && !(scope === 'open' && recentlyShipped.length > 0) ? (
            <div className="rounded-[14px] border border-dashed border-line bg-canvas px-6 py-12 text-center">
              <MessageSquarePlus size={28} className="mx-auto text-ink-dim" aria-hidden="true" />
              <p className="mt-3 text-sm text-ink-soft">
                {items.length === 0
                  ? 'No feedback yet — be the first to share a bug or an idea.'
                  : 'Nothing matches these filters.'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {inScope.length > 0 &&
                (sort === 'newest' ? flatBody : <>{groupedBody}</>)}
              {/* Piece 1 — keep recently-shipped work visible in the default
                  Open view instead of burying it behind the Resolved filter. */}
              {scope === 'open' && recentlyShipped.length > 0 && (
                <RecentlyShippedBand
                  items={recentlyShipped}
                  renderCard={renderCard}
                  onSeeAll={() => setScope('resolved')}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {modalOpen && <FeedbackModal onClose={() => setModalOpen(false)} onCreated={handleCreated} />}
    </DesignerChrome>
  )
}

// The prominent "What we did / Why we closed this" panel for a resolved item's
// resolution_note — the admin's explanation, surfaced to the whole team. The
// wrapper span is muted by default; a `done` item overrides to the in-stock
// green via inline style (icon + heading inherit currentColor).
function ResolutionPanel({ item }: { item: FeedbackItem }) {
  if (!isResolvedStatus(item.status) || !item.resolution_note) return null
  const isDone = item.status === 'done'
  const Icon = isDone ? CheckCircle2 : Archive
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
      <span
        className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute"
        style={isDone ? { color: 'var(--c-in-stock)' } : undefined}
      >
        <Icon size={13} className="shrink-0" aria-hidden="true" />
        {resolutionHeading(item.status)}
      </span>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">
        {item.resolution_note}
      </p>
    </div>
  )
}

// Per-status past-tense verb for the "resolved for you" callout meta line.
const RESOLVED_VERB: Partial<Record<FeedbackStatus, string>> = {
  done: 'Shipped',
  wont_do: 'Closed',
}

// Piece 2 — the personal loop-closer. The items THIS user raised that have
// been resolved (shipped or declined) since they last opened the board, with
// the outcome + triage note inline so they get the full picture without
// hunting. Shown expanded the moment they arrive, then cleared next visit.
function ResolvedForYouCallout({ items }: { items: FeedbackItem[] }) {
  return (
    <div className="mt-6 overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <CheckCircle2
          size={16}
          className="shrink-0"
          style={{ color: 'var(--c-in-stock)' }}
          aria-hidden="true"
        />
        <span className="text-[13px] font-semibold text-ink">Resolved since you last looked</span>
        <span className="font-mono text-[12px] tabular-nums text-ink-mute">· {items.length}</span>
      </div>
      <ul className="divide-y divide-line-soft">
        {items.map((it) => (
          <li key={it.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <FeedbackStatusPill status={it.status} />
              <span className="text-[14px] font-medium text-ink">{it.title}</span>
            </div>
            {/* Prefer the resolution explanation; fall back to the running note. */}
            {(it.resolution_note || it.admin_note) && (
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">
                {it.resolution_note || it.admin_note}
              </p>
            )}
            <p className="mt-1 text-[12px] text-ink-mute">
              {RESOLVED_VERB[it.status] ?? 'Updated'} {relativeTime(it.status_changed_at)}
              {it.status_changed_by_name ? ` by ${it.status_changed_by_name}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Piece 1 — recently-shipped momentum band for the default Open view.
// Collapsed by default (it's secondary to open work) but the header keeps the
// count visible, so shipped work is never fully hidden. "See all shipped"
// jumps to the Resolved scope for the full history.
function RecentlyShippedBand({
  items,
  renderCard,
  onSeeAll,
}: {
  items: FeedbackItem[]
  renderCard: (
    it: FeedbackItem,
    showStatus: boolean,
    opts?: { resolutionInline?: boolean },
  ) => React.ReactNode
  onSeeAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[8px] px-1 py-1.5 text-left hover:bg-canvas"
      >
        <Chevron size={16} className="shrink-0 text-ink-mute" aria-hidden="true" />
        <CheckCircle2
          size={15}
          className="shrink-0"
          style={{ color: 'var(--c-in-stock)' }}
          aria-hidden="true"
        />
        <span className="text-[13px] font-medium text-ink">Recently shipped</span>
        <span className="font-mono text-[12px] tabular-nums text-ink-mute">· {items.length}</span>
        <span className="ml-1 text-[11px] text-ink-dim">last {RECENTLY_SHIPPED_DAYS} days</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {/* resolutionInline shows each item's "What we did" explanation on the
              collapsed card, so the team reads what shipped without expanding. */}
          {items.map((it) => renderCard(it, false, { resolutionInline: true }))}
          <button
            type="button"
            onClick={onSeeAll}
            className="text-[12px] font-medium text-brand hover:underline"
          >
            See all shipped →
          </button>
        </div>
      )}
    </section>
  )
}

// Lifecycle-scope filter pill, matching the dashboard's chip row:
// active = solid ink, inactive = outlined.
function FilterPill({
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
        'inline-flex h-[30px] items-center rounded-full px-3 text-[12px] font-medium transition-colors max-md:shrink-0',
        active
          ? 'border border-ink bg-ink text-on-ink'
          : 'border border-line bg-surface text-ink-soft hover:bg-canvas',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// Section header row — chevron + label + per-section count. Toggles collapse.
function SectionHeader({
  section,
  label,
  count,
  expanded,
  onToggle,
}: {
  section: FeedbackSection
  label: string
  count: number
  expanded: boolean
  onToggle: () => void
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2 rounded-[8px] px-1 py-1.5 text-left hover:bg-canvas"
    >
      <Chevron size={16} className="shrink-0 text-ink-mute" aria-hidden="true" />
      {section === 'shipped' && (
        <CheckCircle2 size={15} className="shrink-0" style={{ color: 'var(--c-in-stock)' }} aria-hidden="true" />
      )}
      {section === 'parked' && (
        <Archive size={15} className="shrink-0 text-ink-mute" aria-hidden="true" />
      )}
      <span className="text-[13px] font-medium text-ink">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-ink-mute">· {count}</span>
    </button>
  )
}

// Sub-status divider inside Open work — a coloured dot + label carry the status
// that used to be a per-card pill.
function SubDivider({ status, count }: { status: FeedbackStatus; count: number }) {
  const meta = FEEDBACK_STATUS_META[status]
  return (
    <div className="mb-1 mt-2 flex items-center gap-2 px-1">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: PILL_DOT[meta.colour] }}
        aria-hidden="true"
      />
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">{meta.label}</span>
      <span className="font-mono text-[11px] tabular-nums text-ink-dim">{count}</span>
    </div>
  )
}

// Monochrome type glyph that replaces the coloured Type pill on each card.
function TypeIcon({ type }: { type: FeedbackType }) {
  const Icon = TYPE_ICON[type]
  return <Icon size={15} className="shrink-0 text-ink-mute" aria-label={FEEDBACK_TYPE_META[type].label} />
}

// Secondary filter dropdown, mirroring the dashboard's SelectField: a muted
// label, a native <select> with the OS chrome stripped, and an overlay chevron.
function FilterSelect({
  label,
  value,
  onChange,
  options,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <div
      className={`relative inline-flex items-center rounded-[8px] border border-line bg-surface transition-colors hover:bg-canvas focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)] ${className}`}
    >
      <span className="pointer-events-none select-none pl-2.5 text-xs font-medium text-ink-mute">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-xs font-medium text-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-mute"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 6 8 10 12 6" />
      </svg>
    </div>
  )
}

// Checkbox-style toggle (Mine), matching the dashboard's "Abandoned" control.
function FilterToggle({
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
        'inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors max-md:shrink-0',
        active
          ? 'border-line bg-canvas text-ink'
          : 'border-line bg-surface text-ink-mute hover:bg-canvas hover:text-ink-soft',
      ].join(' ')}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
          active ? 'border-ink bg-ink' : 'border-line'
        }`}
      >
        {active && (
          <svg
            viewBox="0 0 10 10"
            className="h-2.5 w-2.5 text-on-ink"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="1.5 5 4 7.5 8.5 2.5" />
          </svg>
        )}
      </span>
      {children}
    </button>
  )
}

function FeedbackCard({
  item,
  isAdmin,
  canDelete,
  showStatus,
  isNew,
  resolutionInline,
  expanded,
  onToggleExpand,
  onSaveTriage,
  onDelete,
}: {
  item: FeedbackItem
  isAdmin: boolean
  canDelete: boolean
  showStatus: boolean
  isNew: boolean
  /** Show the "What we did" panel on the collapsed card (used by the band). */
  resolutionInline: boolean
  expanded: boolean
  onToggleExpand: () => void
  onSaveTriage: (
    item: FeedbackItem,
    status: FeedbackStatus,
    priority: FeedbackPriority,
    note: string,
    resolutionNote: string,
  ) => Promise<boolean>
  onDelete: (item: FeedbackItem) => void
}) {
  const [signedUrls, setSignedUrls] = useState<string[] | null>(null)
  const [statusDraft, setStatusDraft] = useState<FeedbackStatus>(item.status)
  const [priorityDraft, setPriorityDraft] = useState<FeedbackPriority>(item.priority)
  const [noteDraft, setNoteDraft] = useState(item.admin_note ?? '')
  const [resolutionDraft, setResolutionDraft] = useState(item.resolution_note ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // Re-seed the admin drafts if the underlying item changes (e.g. after a save).
  useEffect(() => {
    setStatusDraft(item.status)
    setPriorityDraft(item.priority)
    setNoteDraft(item.admin_note ?? '')
    setResolutionDraft(item.resolution_note ?? '')
  }, [item.status, item.priority, item.admin_note, item.resolution_note])

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

  const dirty =
    statusDraft !== item.status ||
    priorityDraft !== item.priority ||
    (noteDraft.trim() || null) !== (item.admin_note ?? null) ||
    (resolutionDraft.trim() || null) !== (item.resolution_note ?? null)

  // Priority is the only signal allowed loud colour: a left edge-stripe, with a
  // small word on the meta line as a backstop (a 3px stripe alone is too easy to
  // miss on a phone, and "no stripe" must not read as "broken").
  const stripeColour =
    item.priority === 'high' ? 'var(--c-out)' : item.priority === 'medium' ? 'var(--c-low)' : null
  const priorityWord = item.priority === 'high' ? 'High' : item.priority === 'medium' ? 'Med' : null

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setSaveError(false)
    const ok = await onSaveTriage(item, statusDraft, priorityDraft, noteDraft, resolutionDraft)
    setSaving(false)
    if (ok) {
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } else {
      setSaveError(true)
    }
  }

  return (
    <div className="relative overflow-hidden rounded-[14px] border border-line bg-surface">
      {stripeColour && (
        <span
          className="absolute bottom-0 left-0 top-0 w-[3px]"
          style={{ background: stripeColour }}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-canvas"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TypeIcon type={item.type} />
            {showStatus && <FeedbackStatusPill status={item.status} />}
            {isNew && (
              <span className="inline-flex items-center rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                New
              </span>
            )}
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
            {priorityWord && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-medium" style={{ color: stripeColour ?? undefined }}>
                  {priorityWord}
                </span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Collapsed-card explanation for the Recently-shipped band, so the team
          reads what shipped without expanding. Hidden once expanded (the body
          shows the same panel). */}
      {resolutionInline && !expanded && isResolvedStatus(item.status) && item.resolution_note && (
        <div className="border-t border-line-soft px-4 py-3">
          <ResolutionPanel item={item} />
        </div>
      )}

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

          {/* Resolution explanation — the prominent "What we did / Why we closed
              this" panel for resolved items, shown to everyone. */}
          {isResolvedStatus(item.status) && item.resolution_note && (
            <div className="mt-3">
              <ResolutionPanel item={item} />
            </div>
          )}

          {/* Running triage note — shown to everyone once written, but suppressed
              on resolved items where the resolution panel supersedes it. */}
          {item.admin_note &&
            !isAdmin &&
            !(isResolvedStatus(item.status) && item.resolution_note) && (
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

              {/* Done-time explanation. Revealed only when resolving, so the
                  admin is prompted to close the loop with the team. */}
              {(statusDraft === 'done' || statusDraft === 'wont_do') && (
                <div className="mt-3 rounded-lg border border-line bg-surface p-3">
                  <label className="block">
                    <span className="block text-[12px] font-semibold text-ink">
                      {statusDraft === 'wont_do'
                        ? 'Why are you closing this?'
                        : 'What changed & how it works'}
                      <span className="font-normal text-ink-mute"> — shown to the whole team</span>
                    </span>
                    <Textarea
                      value={resolutionDraft}
                      onChange={(e) => setResolutionDraft(e.target.value)}
                      rows={4}
                      placeholder={
                        statusDraft === 'wont_do'
                          ? 'Explain why, so the person who raised it understands.'
                          : "Explain what you did and how to use it, so the team knows what's new."
                      }
                      className="mt-1.5"
                    />
                  </label>
                  {!resolutionDraft.trim() && (
                    <p className="mt-1.5 text-[11px] text-ink-mute">
                      Tip: this is what the team sees on the board when the item ships.
                    </p>
                  )}
                </div>
              )}

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
