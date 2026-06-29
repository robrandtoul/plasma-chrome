import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Flag,
  ChevronDown,
  ChevronUp,
  Phone,
  StickyNote,
  ExternalLink,
  Trash2,
  Package,
  Calendar,
  Mail,
  X,
} from 'lucide-react'
import { DesignerChrome, ButtonCoral, ButtonGhost, Pill } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import FlagProjectModal from '../components/FlagProjectModal'
import {
  WATCH_CATEGORY_META,
  WATCH_STATUS_META,
  WATCH_STATUSES,
  WATCH_STATUS_HINT,
  WATCH_UPDATE_KINDS,
  authorBadgeColour,
  relativeTime,
  formatDue,
  isOverdue,
  isHelpScoutKind,
  type WatchItem,
  type WatchUpdate,
  type WatchStatus,
  type WatchUpdateKind,
} from '../lib/watchList'

type ThumbInfo = { thumb_url: string; preview_url: string; full_url: string }
type HsActivity = { custReplyAt: string | null; replyAt: string | null }
type Scope = 'active' | 'resolved' | 'all'

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

// Active = the working board: open + monitoring. Resolved drops off it.
const ACTIVE_STATUSES: WatchStatus[] = ['open', 'monitoring']

function projectLabel(item: WatchItem): string {
  return item.company_name?.trim() || item.contact_name?.trim() || 'Untitled project'
}

function initialsFor(item: WatchItem): string {
  const base = projectLabel(item)
  return base
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase()
}

function formatOrdered(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// The customer's last Help Scout reply, but only if it landed AFTER the project
// was flagged — i.e. genuinely new activity the board should surface.
function replySinceFlag(hs: HsActivity | undefined, item: WatchItem): string | null {
  if (!hs?.custReplyAt) return null
  return new Date(hs.custReplyAt).getTime() > new Date(item.created_at).getTime()
    ? hs.custReplyAt
    : null
}

// Small round initials badge, coloured to match the author's header avatar.
function AuthorBadge({ initials, colour }: { initials: string | null; colour: string | null }) {
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-medium text-white"
      style={{ backgroundColor: authorBadgeColour(colour) }}
      aria-hidden="true"
    >
      {(initials ?? '?').slice(0, 2)}
    </span>
  )
}

// Avatar for a Help Scout-ingested thread entry (no staff profile behind it).
function HsBadge({ customer }: { customer: boolean }) {
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
      style={{ backgroundColor: customer ? '#7b3ff2' : 'var(--c-allocated)' }}
      aria-hidden="true"
    >
      <Mail size={13} />
    </span>
  )
}

// The leading icon for an update by kind (HS / phone call / note).
function UpdateIcon({ kind, size = 12 }: { kind: WatchUpdateKind; size?: number }) {
  if (isHelpScoutKind(kind)) return <Mail size={size} aria-hidden="true" />
  if (kind === 'phone_call') return <Phone size={size} aria-hidden="true" />
  return <StickyNote size={size} aria-hidden="true" />
}

export default function FlaggedPage() {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'

  const [meName, setMeName] = useState<string | null>(null)
  const [items, setItems] = useState<WatchItem[]>([])
  const [updatesByItem, setUpdatesByItem] = useState<Record<string, WatchUpdate[]>>({})
  const [thumbByProof, setThumbByProof] = useState<Record<string, ThumbInfo>>({})
  const [hsByProof, setHsByProof] = useState<Record<string, HsActivity>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [scope, setScope] = useState<Scope>('active')
  const [sortMode, setSortMode] = useState<'status' | 'newest'>('status')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [flagOpen, setFlagOpen] = useState(false)
  const [lightbox, setLightbox] = useState<ThumbInfo | null>(null)

  // Per-card "add an update" drafts.
  const [draftBody, setDraftBody] = useState<Record<string, string>>({})
  const [draftKind, setDraftKind] = useState<Record<string, WatchUpdateKind>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .single()
      if (!cancelled) setMeName((data?.full_name as string | null) ?? null)
    })()
    return () => { cancelled = true }
  }, [userId])

  async function load() {
    setLoadError(null)
    const { data, error } = await supabase
      .from('watch_items')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) {
      setLoadError('Could not load the flagged board. Please reload.')
      setLoading(false)
      return
    }
    const rows = (data ?? []) as WatchItem[]
    setItems(rows)
    setLoading(false)

    const itemIds = rows.map((r) => r.id)
    const proofIds = Array.from(new Set(rows.map((r) => r.proof_id)))

    type ProjRow = {
      proof_id: string
      current_version_id: string | null
      helpscout_last_customer_reply_at: string | null
      helpscout_last_reply_at: string | null
    }

    // Thread + project context load in parallel; both are best-effort.
    const [updatesRes, projectsRes] = await Promise.all([
      itemIds.length
        ? supabase
            .from('watch_updates')
            .select('*')
            .in('watch_item_id', itemIds)
            .order('created_at', { ascending: true })
        : Promise.resolve({ data: [] as WatchUpdate[] }),
      proofIds.length
        ? supabase
            .from('public_dashboard_projects')
            .select('proof_id, current_version_id, helpscout_last_customer_reply_at, helpscout_last_reply_at')
            .in('proof_id', proofIds)
        : Promise.resolve({ data: [] as ProjRow[] }),
    ])

    const grouped: Record<string, WatchUpdate[]> = {}
    for (const u of (updatesRes.data ?? []) as WatchUpdate[]) {
      ;(grouped[u.watch_item_id] ??= []).push(u)
    }
    setUpdatesByItem(grouped)

    const projects = (projectsRes.data ?? []) as ProjRow[]
    const hs: Record<string, HsActivity> = {}
    const versionToProof = new Map<string, string>()
    for (const p of projects) {
      hs[p.proof_id] = {
        custReplyAt: p.helpscout_last_customer_reply_at,
        replyAt: p.helpscout_last_reply_at,
      }
      if (p.current_version_id) versionToProof.set(p.current_version_id, p.proof_id)
    }
    setHsByProof(hs)

    const versionIds = Array.from(versionToProof.keys())
    if (versionIds.length > 0) {
      const { data: thumbData } = await supabase.functions.invoke('dashboard-thumbnails', {
        body: { versionIds },
      })
      const thumbs = (thumbData?.thumbs ?? {}) as Record<string, ThumbInfo>
      const byProof: Record<string, ThumbInfo> = {}
      for (const [versionId, urls] of Object.entries(thumbs)) {
        const proofId = versionToProof.get(versionId)
        if (proofId && urls?.thumb_url) byProof[proofId] = urls
      }
      setThumbByProof(byProof)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!lightbox) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function postUpdate(item: WatchItem) {
    if (!userId) return
    const body = (draftBody[item.id] ?? '').trim()
    if (!body) return
    const kind = draftKind[item.id] ?? 'note'
    setBusyId(item.id)
    const { data, error } = await supabase
      .from('watch_updates')
      .insert({ watch_item_id: item.id, kind, body, created_by: userId })
      .select('*')
      .single()
    setBusyId(null)
    if (error || !data) return
    const row = data as WatchUpdate
    setUpdatesByItem((prev) => ({ ...prev, [item.id]: [...(prev[item.id] ?? []), row] }))
    setDraftBody((prev) => ({ ...prev, [item.id]: '' }))
    void logAudit({
      action: 'watch.update_added',
      targetType: 'watch_item',
      targetId: item.id,
      targetLabel: projectLabel(item),
      metadata: { kind },
    })
  }

  async function changeStatus(item: WatchItem, status: WatchStatus) {
    if (item.status === status) return
    setBusyId(item.id)
    const stamp = new Date().toISOString()
    const { error } = await supabase
      .from('watch_items')
      .update({
        status,
        status_changed_at: stamp,
        status_changed_by: userId,
        status_changed_by_name: meName,
        updated_at: stamp,
      })
      .eq('id', item.id)
    setBusyId(null)
    if (error) return
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, status, status_changed_at: stamp, status_changed_by: userId, status_changed_by_name: meName, updated_at: stamp }
          : it,
      ),
    )
    void logAudit({
      action: 'watch.status_changed',
      targetType: 'watch_item',
      targetId: item.id,
      targetLabel: projectLabel(item),
      metadata: { status },
    })
  }

  // Set / clear the expected-resolution date. Silent no-op if the 000291 column
  // isn't applied yet (the update errors and we just don't reflect it).
  async function updateDue(item: WatchItem, value: string | null) {
    setBusyId(item.id)
    const { error } = await supabase
      .from('watch_items')
      .update({ due_on: value, updated_at: new Date().toISOString() })
      .eq('id', item.id)
    setBusyId(null)
    if (error) return
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, due_on: value } : it)))
  }

  async function removeItem(item: WatchItem) {
    if (!window.confirm('Remove this project from the flagged board? Its update thread will be deleted too.')) return
    setBusyId(item.id)
    const { error } = await supabase.from('watch_items').delete().eq('id', item.id)
    setBusyId(null)
    if (error) return
    setItems((prev) => prev.filter((it) => it.id !== item.id))
    void logAudit({
      action: 'watch.removed',
      targetType: 'watch_item',
      targetId: item.id,
      targetLabel: projectLabel(item),
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      [it.company_name, it.contact_name, it.designer_name, it.stock_order_number]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    )
  }, [items, search])

  const counts = useMemo(() => {
    const c = { open: 0, monitoring: 0, resolved: 0 }
    for (const it of items) c[it.status] += 1
    return c
  }, [items])

  function renderCard(item: WatchItem) {
    const isExpanded = expanded.has(item.id)
    const thread = updatesByItem[item.id] ?? []
    const last = thread[thread.length - 1] ?? null
    const thumb = thumbByProof[item.proof_id] ?? null
    const cat = WATCH_CATEGORY_META[item.category]
    const st = WATCH_STATUS_META[item.status]
    const ordered = formatOrdered(item.ordered_on)
    const canDelete = item.created_by === userId || isAdmin
    const overdue = isOverdue(item.due_on, item.status)
    const replied = replySinceFlag(hsByProof[item.proof_id], item)
    const meta = [item.contact_name, item.designer_name, ordered && `Ordered ${ordered}`, item.stock_order_number && `#${item.stock_order_number}`]
      .filter(Boolean)
      .join(' · ')

    return (
      <div key={item.id} className="overflow-hidden rounded-[14px] border border-line bg-surface">
        <div className="flex items-stretch gap-3 p-3 hover:bg-canvas">
          {/* Thumbnail — click to enlarge (falls back to expand when there's no art). */}
          <button
            type="button"
            onClick={() => (thumb ? setLightbox(thumb) : toggleExpand(item.id))}
            aria-label={thumb ? 'Enlarge artwork' : 'Expand'}
            className={[
              'flex h-24 w-36 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-ink font-mono text-[14px] font-medium tracking-wider text-on-ink',
              thumb ? 'cursor-zoom-in' : '',
            ].join(' ')}
          >
            {thumb ? (
              <img src={thumb.thumb_url} alt="" loading="lazy" className="h-full w-full object-contain" />
            ) : (
              initialsFor(item)
            )}
          </button>

          <button
            type="button"
            onClick={() => toggleExpand(item.id)}
            aria-expanded={isExpanded}
            className="min-w-0 flex-1 text-left"
          >
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold text-ink">{projectLabel(item)}</span>
              <Pill colour={cat.colour}>{cat.label}</Pill>
              <Pill colour={st.colour}>{st.label}</Pill>
              {item.due_on && (
                <span
                  className={[
                    'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                    overdue ? 'bg-out-soft text-out' : 'bg-line-soft text-ink-soft',
                  ].join(' ')}
                >
                  <Calendar size={11} aria-hidden="true" />
                  {formatDue(item.due_on, item.status)}
                </span>
              )}
              {replied && (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand">
                  <Mail size={11} aria-hidden="true" />
                  Customer replied · {relativeTime(replied)}
                </span>
              )}
            </span>
            {meta && <span className="mt-0.5 block truncate text-[12px] text-ink-mute">{meta}</span>}
            <span className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-soft">
              {last ? (
                <>
                  <UpdateIcon kind={last.kind} />
                  <span className="truncate">
                    <span className="font-medium text-ink">{last.created_by_name ?? 'Someone'}</span>{' '}
                    {last.body}
                  </span>
                  <span className="shrink-0 text-ink-dim">· {relativeTime(last.created_at)}</span>
                </>
              ) : (
                <span className="text-ink-dim">No updates yet</span>
              )}
            </span>
          </button>

          <button
            type="button"
            onClick={() => toggleExpand(item.id)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            className="flex shrink-0 items-start pt-0.5 text-ink-mute"
          >
            {isExpanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </button>
        </div>

        {isExpanded && (
          <div className="border-t border-line-soft px-3 py-3">
            {/* Thread */}
            <div className="divide-y divide-line-soft">
              {thread.length === 0 && (
                <p className="text-[13px] text-ink-mute">No updates yet — add the first below.</p>
              )}
              {thread.map((u) => {
                const hs = isHelpScoutKind(u.kind)
                return (
                  <div key={u.id} className="flex gap-3 py-4 first:pt-0">
                    {hs ? (
                      <HsBadge customer={u.kind === 'helpscout_customer'} />
                    ) : (
                      <AuthorBadge initials={u.created_by_initials} colour={u.created_by_colour} />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                        <span className="font-medium text-ink">{u.created_by_name ?? 'Someone'}</span>
                        {hs ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand">
                            <Mail size={11} aria-hidden="true" /> Help Scout · {u.kind === 'helpscout_customer' ? 'customer' : 'staff'}
                          </span>
                        ) : u.kind === 'phone_call' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-line-soft px-1.5 py-0.5 text-[11px] text-ink-soft">
                            <Phone size={11} aria-hidden="true" /> Phone call
                          </span>
                        ) : null}
                        <span className="text-ink-dim">· {formatStamp(u.created_at)}</span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{u.body}</p>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Add an update */}
            <div className="mt-4 rounded-[10px] border border-line bg-canvas p-2.5">
              <div className="mb-2 flex gap-1.5" role="radiogroup" aria-label="Update type">
                {WATCH_UPDATE_KINDS.map((k) => {
                  const active = (draftKind[item.id] ?? 'note') === k.value
                  return (
                    <button
                      key={k.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setDraftKind((p) => ({ ...p, [item.id]: k.value }))}
                      className={[
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
                        active ? 'bg-ink text-on-ink' : 'text-ink-mute hover:bg-surface',
                      ].join(' ')}
                    >
                      {k.value === 'phone_call' ? <Phone size={12} aria-hidden="true" /> : <StickyNote size={12} aria-hidden="true" />}
                      {k.label}
                    </button>
                  )
                })}
              </div>
              <textarea
                value={draftBody[item.id] ?? ''}
                onChange={(e) => setDraftBody((p) => ({ ...p, [item.id]: e.target.value }))}
                rows={2}
                placeholder="Log an update or a phone call…"
                className="w-full resize-y rounded-[8px] border border-line bg-surface px-2.5 py-2 text-[14px] text-ink outline-none placeholder:text-ink-dim focus:border-brand"
              />
              <div className="mt-2 flex justify-end">
                <ButtonCoral
                  size="sm"
                  busy={busyId === item.id}
                  disabled={!(draftBody[item.id] ?? '').trim()}
                  onClick={() => void postUpdate(item)}
                >
                  Post update
                </ButtonCoral>
              </div>
            </div>

            {/* Status + expected resolution */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-ink-mute">Status</span>
                <div className="flex gap-1">
                  {WATCH_STATUSES.map((s) => {
                    const active = item.status === s.value
                    return (
                      <button
                        key={s.value}
                        type="button"
                        title={WATCH_STATUS_HINT[s.value]}
                        disabled={busyId === item.id || active}
                        onClick={() => void changeStatus(item, s.value)}
                        className={[
                          'rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-default',
                          active
                            ? 'border-brand bg-brand-50 text-ink'
                            : 'border-line bg-surface text-ink-mute hover:bg-canvas',
                        ].join(' ')}
                      >
                        {s.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-mute">
                <Calendar size={13} aria-hidden="true" />
                Resolve by
                <input
                  type="date"
                  value={item.due_on ?? ''}
                  onChange={(e) => void updateDue(item, e.target.value || null)}
                  className="rounded-[6px] border border-line bg-surface px-1.5 py-1 text-[12px] text-ink outline-none focus:border-brand"
                />
                {item.due_on && (
                  <button
                    type="button"
                    onClick={() => void updateDue(item, null)}
                    className="text-ink-dim hover:text-ink"
                    aria-label="Clear date"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </label>
            </div>

            {/* Links */}
            <div className="mt-2 flex items-center gap-1">
              <Link to={`/proofs/${item.proof_id}`}>
                <ButtonGhost size="sm" icon={Package}>Project</ButtonGhost>
              </Link>
              {item.helpscout_conversation_url && (
                <a href={item.helpscout_conversation_url} target="_blank" rel="noopener noreferrer">
                  <ButtonGhost size="sm" icon={ExternalLink}>Help Scout</ButtonGhost>
                </a>
              )}
              {canDelete && (
                <ButtonGhost size="sm" icon={Trash2} onClick={() => void removeItem(item)}>Remove</ButtonGhost>
              )}
            </div>

            {item.status === 'resolved' && item.status_changed_by_name && (
              <p className="mt-2 text-[12px] text-ink-mute">
                Resolved by {item.status_changed_by_name}
                {item.status_changed_at ? ` · ${formatStamp(item.status_changed_at)}` : ''}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderSections(statuses: WatchStatus[]) {
    return (
      <div className="space-y-6">
        {statuses.map((sv) => {
          const group = filtered.filter((it) => it.status === sv)
          if (group.length === 0) return null
          const sm = WATCH_STATUS_META[sv]
          return (
            <section key={sv}>
              <div className="mb-2 flex items-center gap-2">
                <Pill colour={sm.colour}>{sm.label}</Pill>
                <span className="rounded-full bg-line-soft px-2 py-0.5 text-[11px] text-ink-soft">{group.length}</span>
                <span className="text-[12px] text-ink-dim">{WATCH_STATUS_HINT[sv]}</span>
              </div>
              <div className="space-y-3">{group.map(renderCard)}</div>
            </section>
          )
        })}
      </div>
    )
  }

  const inScope =
    scope === 'resolved'
      ? filtered.filter((it) => it.status === 'resolved')
      : scope === 'active'
        ? filtered.filter((it) => it.status !== 'resolved')
        : filtered

  const body = (() => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-[14px] bg-line-soft" />
          ))}
        </div>
      )
    }
    if (loadError) {
      return <p className="rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">{loadError}</p>
    }
    if (inScope.length === 0) {
      return (
        <div className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center">
          <Flag size={22} aria-hidden="true" className="mx-auto text-ink-dim" />
          <p className="mt-2 text-[14px] font-medium text-ink">
            {scope === 'active' ? 'Nothing flagged' : 'Nothing here'}
          </p>
          <p className="mt-1 text-[13px] text-ink-mute">
            Flag a project to start tracking a problem order.
          </p>
        </div>
      )
    }
    // Flat, newest-first — for the Resolved scope and the "Newest" sort. The
    // default "By status" sort keeps the grouped view (Open section on top).
    if (scope === 'resolved' || sortMode === 'newest') {
      return (
        <div className="space-y-3">
          {[...inScope].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(renderCard)}
        </div>
      )
    }
    return renderSections(scope === 'all' ? ['open', 'monitoring', 'resolved'] : ACTIVE_STATUSES)
  })()

  const scopeCount = (s: Scope): number =>
    s === 'all' ? items.length : s === 'resolved' ? counts.resolved : counts.open + counts.monitoring

  return (
    <DesignerChrome
      active="flagged"
      search={{ value: search, onChange: setSearch, placeholder: 'Search by company, contact, designer, order #…' }}
      actions={
        <ButtonCoral icon={Flag} onClick={() => setFlagOpen(true)}>
          <span className="max-sm:hidden">Flag a project</span>
          <span className="sm:hidden">Flag</span>
        </ButtonCoral>
      }
    >
      <main className="mx-auto max-w-[920px] px-4 py-6 sm:px-7">
        <div className="mb-1 flex items-center gap-2">
          <Flag size={20} aria-hidden="true" className="text-brand" />
          <h1 className="text-[20px] font-semibold text-ink">Flagged</h1>
        </div>
        <p className="mb-4 text-[13px] text-ink-mute">
          Problem projects everyone can see and update — lost in transit, reprints, complaints, delays.
        </p>

        {/* Scope chips + sort */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {SCOPES.map((s) => {
            const active = scope === s.value
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => setScope(s.value)}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                  active ? 'bg-ink text-on-ink' : 'border border-line text-ink-mute hover:bg-canvas',
                ].join(' ')}
              >
                {s.label}
                <span className={['text-[11px]', active ? 'text-on-ink/70' : 'text-ink-dim'].join(' ')}>{scopeCount(s.value)}</span>
              </button>
            )
          })}
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[12px] text-ink-mute">Sort</span>
            {([['status', 'By status'], ['newest', 'Newest']] as const).map(([val, label]) => {
              const active = sortMode === val
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setSortMode(val)}
                  title={val === 'status' ? 'Open at the top, then Monitoring' : 'Most recently flagged first'}
                  className={[
                    'rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
                    active ? 'bg-ink text-on-ink' : 'border border-line text-ink-mute hover:bg-canvas',
                  ].join(' ')}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Status legend — what each status means + the colour key. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[10px] border border-line bg-canvas px-3 py-2 text-[12px]">
          {WATCH_STATUSES.map((s) => (
            <span key={s.value} className="inline-flex items-center gap-1.5">
              <Pill colour={s.colour}>{s.label}</Pill>
              <span className="text-ink-mute">{WATCH_STATUS_HINT[s.value]}</span>
            </span>
          ))}
        </div>

        {body}
      </main>

      {flagOpen && (
        <FlagProjectModal
          onClose={() => setFlagOpen(false)}
          onCreated={(item) => {
            setFlagOpen(false)
            setItems((prev) => [item, ...prev])
            setExpanded((prev) => new Set(prev).add(item.id))
            // Pull the freshly-stamped thread + thumbnail in.
            void load()
          }}
        />
      )}

      {/* Artwork lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Artwork preview"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.full_url || lightbox.preview_url}
            alt="Proof artwork"
            className="max-h-[85vh] max-w-[90vw] rounded-lg bg-white object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-ink hover:bg-white"
          >
            <X size={22} aria-hidden="true" />
          </button>
        </div>
      )}
    </DesignerChrome>
  )
}
