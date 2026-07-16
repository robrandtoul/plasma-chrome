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
// active notices; admins additionally get the "Post announcement" control and a
// Remove button on each card. Renders nothing for a designer when there's
// nothing live, so it costs zero pixels in normal operation.
//
// Fetch-on-mount (no realtime — the dashboard reloads through the day and admin
// posts are infrequent). Active-window filtering is client-side so an expiry
// that lapses while the page is open hides the card without a refetch.

const TONE_ICON: Record<AnnouncementTone, LucideIcon> = {
  info: Info,
  offer: Tag,
  warning: AlertTriangle,
}

export default function AnnouncementsBanner() {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)

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
  }, [])

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

  function handleCreated(a: Announcement) {
    setItems((prev) => [a, ...prev])
    setComposing(false)
  }

  // Nothing to show and not an admin → render nothing (no empty gap).
  if (loading) return null
  if (active.length === 0 && !isAdmin) return null

  return (
    <div className="mb-6">
      {isAdmin && (
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Announcements</span>
          <ButtonGhost size="sm" icon={Megaphone} onClick={() => setComposing(true)}>
            Post announcement
          </ButtonGhost>
        </div>
      )}

      {active.length > 0 ? (
        <div className="space-y-2">
          {active.map((a) => {
            const meta = ANNOUNCEMENT_TONE_META[a.tone]
            const Icon = TONE_ICON[a.tone]
            const expiry = announcementExpiryLabel(a.expires_at)
            return (
              <div
                key={a.id}
                className="flex items-start gap-3 rounded-[14px] border border-line bg-surface py-3 pl-4 pr-3"
                style={{ borderLeftColor: meta.accent, borderLeftWidth: 3 }}
              >
                <span className="mt-0.5 flex-shrink-0" style={{ color: meta.accent }} aria-hidden="true">
                  <Icon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-[14px] leading-snug text-ink">{a.body}</p>
                  {(expiry || isAdmin) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-mute">
                      {expiry && <span>{expiry}</span>}
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
                    className="flex-shrink-0 rounded-full p-1 text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        isAdmin && (
          <p className="text-[13px] text-ink-mute">
            No announcements right now. Post one and everyone will see it here.
          </p>
        )
      )}

      {composing && (
        <AnnouncementModal onClose={() => setComposing(false)} onCreated={handleCreated} />
      )}
    </div>
  )
}
