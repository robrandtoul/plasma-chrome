import { useEffect, useState } from 'react'
import { Megaphone, Info, Tag, AlertTriangle, X, type LucideIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { relativeTime } from '../lib/relativeTime'
import { ButtonGhost } from '../design'
import AnnouncementModal from './AnnouncementModal'
import {
  ANNOUNCEMENT_TONE_META,
  announcementExpiryLabel,
  isAnnouncementActive,
  type Announcement,
  type AnnouncementTone,
} from '../lib/announcements'

// The dashboard announcements strip (migration 000318). Everyone sees the
// active notices; admins additionally get a Remove button on each card.
//
// Renders nothing when there's nothing live — for EVERYONE, admins included.
// The strip sits above the hero, which is the best real estate on the page, and
// an empty state there charged rent every morning for a feature that is used
// occasionally. The "Post announcement" control that used to live in this
// component's header is now <PostAnnouncementButton />, mounted in the hero's
// action cluster next to "New project", so admins keep the entry point without
// the component needing to render an empty shell to hold it.
//
// Fetch-on-mount (no realtime — the dashboard reloads through the day and admin
// posts are infrequent). Active-window filtering is client-side so an expiry
// that lapses while the page is open hides the card without a refetch.
// `refreshKey` lets the hero button pull a freshly-posted notice into view: the
// button owns the modal, so it has no way to hand the new row over directly.

const TONE_ICON: Record<AnnouncementTone, LucideIcon> = {
  info: Info,
  offer: Tag,
  warning: AlertTriangle,
}

export default function AnnouncementsBanner({ refreshKey = 0 }: { refreshKey?: number }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(50)
      if (cancelled) return
      if (!error) setItems((data ?? []) as Announcement[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const active = items.filter((a) => isAnnouncementActive(a))

  async function handleRemove(id: string) {
    const removed = items.find((a) => a.id === id)
    // Optimistic: drop it now, restore if the archive write fails.
    setItems((prev) => prev.filter((a) => a.id !== id))
    const nowIso = new Date().toISOString()
    const { error } = await supabase
      .from('announcements')
      .update({ archived_at: nowIso, updated_at: nowIso })
      .eq('id', id)
    if (error) {
      if (removed) setItems((prev) => [removed, ...prev])
      return
    }
    void logAudit({
      action: 'announcement.removed',
      targetType: 'announcement',
      targetId: id,
      targetLabel: removed?.body.slice(0, 80),
    })
  }

  // Nothing live → render nothing, for every role. An admin used to fall
  // through to a header row and a "No announcements right now" line; the
  // control that justified it now lives in the hero.
  if (loading) return null
  if (active.length === 0) return null

  return (
    <div className="mb-6">
      <div className="space-y-2">
          {active.map((a) => {
            const meta = ANNOUNCEMENT_TONE_META[a.tone]
            const Icon = TONE_ICON[a.tone]
            const expiry = announcementExpiryLabel(a.expires_at)
            return (
              <div
                key={a.id}
                className="flex items-start gap-3 rounded-[14px] border py-3.5 pl-4 pr-3 shadow-[0_2px_10px_-3px_rgba(22,19,17,0.14)]"
                style={{
                  backgroundColor: `color-mix(in srgb, ${meta.accent} 11%, var(--c-surface))`,
                  borderColor: `color-mix(in srgb, ${meta.accent} 34%, transparent)`,
                }}
              >
                <span
                  className="mt-px flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: meta.accent }}
                  aria-hidden="true"
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-[15px] font-medium leading-snug text-ink">{a.body}</p>
                  {(expiry || isAdmin) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-mute">
                      {expiry && (
                        <span className="font-medium" style={{ color: meta.accent }}>
                          {expiry}
                        </span>
                      )}
                      {isAdmin && a.created_by_name && (
                        <span>
                          {expiry ? '· ' : ''}
                          Posted by {a.created_by_name} {relativeTime(a.created_at)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleRemove(a.id)}
                    aria-label="Remove announcement"
                    title="Remove"
                    className="flex-shrink-0 rounded-full p-1 text-ink-mute transition-colors hover:bg-black/5 hover:text-ink"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

// The "Post announcement" entry point, split out of the banner so the banner
// can render nothing when there is nothing to announce. Owns its own modal
// state; mounted in the dashboard hero's action cluster, admin-only.
//
// `onCreated` fires after a successful post so the caller can nudge the banner
// into refetching — the new notice lives in the database by then, and a refetch
// is a cheaper contract than threading the created row back across two
// components that are siblings rather than parent and child.
export function PostAnnouncementButton({
  onCreated,
  className,
}: { onCreated?: () => void; className?: string }) {
  const { role } = useAuth()
  const [composing, setComposing] = useState(false)
  if (role !== 'admin') return null
  return (
    <>
      <ButtonGhost size="sm" icon={Megaphone} className={className} onClick={() => setComposing(true)}>
        Post announcement
      </ButtonGhost>
      {composing && (
        <AnnouncementModal
          onClose={() => setComposing(false)}
          onCreated={() => {
            setComposing(false)
            onCreated?.()
          }}
        />
      )}
    </>
  )
}
