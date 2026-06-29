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
  WATCH_UPDATE_KINDS,
  authorBadgeColour,
  relativeTime,
  type WatchItem,
  type WatchUpdate,
  type WatchStatus,
  type WatchUpdateKind,
} from '../lib/watchList'

type ThumbInfo = { thumb_url: string; preview_url: string; full_url: string }
type Scope = 'open' | 'monitoring' | 'resolved' | 'all'

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

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

export default function FlaggedPage() {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'

  const [meName, setMeName] = useState<string | null>(null)
  const [items, setItems] = useState<WatchItem[]>([])
  const [updatesByItem, setUpdatesByItem] = useState<Record<string, WatchUpdate[]>>({})
  const [thumbByProof, setThumbByProof] = useState<Record<string, ThumbInfo>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [scope, setScope] = useState<Scope>('open')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [flagOpen, setFlagOpen] = useState(false)

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

    // Thread + artwork load in parallel; both are best-effort (a failure leaves
    // the board usable, just without previews / thumbnails).
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
            .select('proof_id, current_version_id')
            .in('proof_id', proofIds)
        : Promise.resolve({ data: [] as { proof_id: string; current_version_id: string | null }[] }),
    ])

    const grouped: Record<string, WatchUpdate[]> = {}
    for (const u of (updatesRes.data ?? []) as WatchUpdate[]) {
      ;(grouped[u.watch_item_id] ??= []).push(u)
    }
    setUpdatesByItem(grouped)

    const projects = (projectsRes.data ?? []) as { proof_id: string; current_version_id: string | null }[]
    const versionToProof = new Map<string, string>()
    for (const p of projects) {
      if (p.current_version_id) versionToProof.set(p.current_version_id, p.proof_id)
    }
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
    const isOpen = expanded.has(item.id)
    const thread = updatesByItem[item.id] ?? []
    const last = thread[thread.length - 1] ?? null
    const thumb = thumbByProof[item.proof_id] ?? null
    const cat = WATCH_CATEGORY_META[item.category]
    const st = WATCH_STATUS_META[item.status]
    const ordered = formatOrdered(item.ordered_on)
    const canDelete = item.created_by === userId || isAdmin
    const meta = [item.contact_name, item.designer_name, ordered && `Ordered ${ordered}`, item.stock_order_number && `#${item.stock_order_number}`]
      .filter(Boolean)
      .join(' · ')

    return (
      <div key={item.id} className="overflow-hidden rounded-[14px] border border-line bg-surface">
        <button
          type="button"
          onClick={() => toggleExpand(item.id)}
          aria-expanded={isOpen}
          className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-canvas"
        >
          <span className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-ink font-mono text-[11px] font-medium tracking-wider text-on-ink">
            {thumb ? (
              <img src={thumb.thumb_url} alt="" loading="lazy" className="h-full w-full object-contain" />
            ) : (
              initialsFor(item)
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold text-ink">{projectLabel(item)}</span>
              <Pill colour={cat.colour}>{cat.label}</Pill>
              <Pill colour={st.colour}>{st.label}</Pill>
            </span>
            {meta && <span className="mt-0.5 block truncate text-[12px] text-ink-mute">{meta}</span>}
            <span className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-soft">
              {last ? (
                <>
                  {last.kind === 'phone_call' ? <Phone size={12} aria-hidden="true" /> : <StickyNote size={12} aria-hidden="true" />}
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
          </span>
          <span className="shrink-0 text-ink-mute">
            {isOpen ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </span>
        </button>

        {isOpen && (
          <div className="border-t border-line-soft px-3 py-3">
            {/* Thread */}
            <div className="space-y-3">
              {thread.length === 0 && (
                <p className="text-[13px] text-ink-mute">No updates yet — add the first below.</p>
              )}
              {thread.map((u) => (
                <div key={u.id} className="flex gap-2.5">
                  <AuthorBadge initials={u.created_by_initials} colour={u.created_by_colour} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span className="font-medium text-ink">{u.created_by_name ?? 'Someone'}</span>
                      {u.kind === 'phone_call' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-line-soft px-1.5 py-0.5 text-[11px] text-ink-soft">
                          <Phone size={11} aria-hidden="true" /> Phone call
                        </span>
                      )}
                      <span className="text-ink-dim">· {formatStamp(u.created_at)}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{u.body}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Add an update */}
            <div className="mt-3 rounded-[10px] border border-line bg-canvas p-2.5">
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

            {/* Status controls + links */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-ink-mute">Status</span>
                <div className="flex gap-1">
                  {WATCH_STATUSES.map((s) => {
                    const active = item.status === s.value
                    return (
                      <button
                        key={s.value}
                        type="button"
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
              <div className="flex items-center gap-1">
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

  const visible = scope === 'all' ? filtered : filtered.filter((it) => it.status === scope)

  const body = (() => {
    if (loading) {
      return (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-[14px] bg-line-soft" />
          ))}
        </div>
      )
    }
    if (loadError) {
      return <p className="rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">{loadError}</p>
    }
    if (visible.length === 0) {
      return (
        <div className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center">
          <Flag size={22} aria-hidden="true" className="mx-auto text-ink-dim" />
          <p className="mt-2 text-[14px] font-medium text-ink">
            {scope === 'open' ? 'Nothing flagged' : 'Nothing here'}
          </p>
          <p className="mt-1 text-[13px] text-ink-mute">
            Flag a project to start tracking a problem order.
          </p>
        </div>
      )
    }
    if (scope === 'all') {
      return (
        <div className="space-y-6">
          {WATCH_STATUSES.map((s) => {
            const group = visible.filter((it) => it.status === s.value)
            if (group.length === 0) return null
            return (
              <section key={s.value}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{s.label}</span>
                  <span className="rounded-full bg-line-soft px-2 py-0.5 text-[11px] text-ink-soft">{group.length}</span>
                </div>
                <div className="space-y-3">{group.map(renderCard)}</div>
              </section>
            )
          })}
        </div>
      )
    }
    return <div className="space-y-3">{visible.map(renderCard)}</div>
  })()

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

        {/* Scope chips */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {SCOPES.map((s) => {
            const active = scope === s.value
            const count = s.value === 'all' ? items.length : counts[s.value]
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
                <span className={['text-[11px]', active ? 'text-on-ink/70' : 'text-ink-dim'].join(' ')}>{count}</span>
              </button>
            )
          })}
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
    </DesignerChrome>
  )
}
