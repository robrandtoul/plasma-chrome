// Types + display metadata for the dashboard announcements banner (admin-posted
// notices — migration 000318). Kept in lockstep with the CHECK constraint on
// proofs.announcements.tone. No React/lucide here so it stays a plain module;
// the banner component owns the per-tone icons.

export type AnnouncementTone = 'info' | 'offer' | 'warning'

// Mirrors proofs.announcements. Author fields are denormalised (stamped by the
// announcements_set_author trigger) so the shared banner never has to join back
// to the self-read-only profiles table.
export interface Announcement {
  id: string
  created_by: string | null
  created_by_name: string | null
  created_by_initials: string | null
  created_by_colour: string | null
  tone: AnnouncementTone
  body: string
  starts_at: string
  expires_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface AnnouncementToneMeta {
  value: AnnouncementTone
  label: string
  // CSS custom property for the card's accent stripe + tone chip. These vars
  // are the same design tokens the header pill colours use (see COLOUR_BG in
  // DesignerHeader), so the banner stays on-palette in light and dark.
  accent: string
}

// Ordered for the compose modal's tone picker.
export const ANNOUNCEMENT_TONES: AnnouncementToneMeta[] = [
  { value: 'info', label: 'Info', accent: 'var(--c-allocated)' },
  { value: 'offer', label: 'Offer', accent: 'var(--c-brand)' },
  { value: 'warning', label: 'Heads-up', accent: 'var(--c-out)' },
]

export const ANNOUNCEMENT_TONE_META: Record<AnnouncementTone, AnnouncementToneMeta> =
  Object.fromEntries(ANNOUNCEMENT_TONES.map((t) => [t.value, t])) as Record<
    AnnouncementTone,
    AnnouncementToneMeta
  >

// Whether a notice should currently show on the banner. Mirrors the SQL intent:
// not archived, started, and not yet expired. Computed client-side so the banner
// can fetch "not archived" once and hide rows as their window lapses without a
// refetch.
export function isAnnouncementActive(a: Announcement, now: number = Date.now()): boolean {
  if (a.archived_at) return false
  const start = new Date(a.starts_at).getTime()
  if (Number.isFinite(start) && start > now) return false
  if (a.expires_at) {
    const end = new Date(a.expires_at).getTime()
    if (Number.isFinite(end) && end <= now) return false
  }
  return true
}

// "Ends 23 Jul" / "Ends 23 Jul 2027" for the card + the compose preview. Returns
// '' when there's no expiry (runs until an admin removes it). Year shown only
// when it differs from the current one, matching relativeTime()'s chrome.
export function announcementExpiryLabel(expiresAt: string | null | undefined): string {
  if (!expiresAt) return ''
  const d = new Date(expiresAt)
  if (!Number.isFinite(d.getTime())) return ''
  const includeYear = d.getFullYear() !== new Date().getFullYear()
  return `Ends ${d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
  })}`
}

// Turn a plain <input type="date"> value ('YYYY-MM-DD') into the ISO instant the
// notice should stop showing: the end of that day in the poster's local time.
// Empty input → null (no expiry). Used by the compose modal.
export function expiryFromDateInput(dateStr: string): string | null {
  const clean = dateStr.trim()
  if (!clean) return null
  const d = new Date(`${clean}T23:59:59`)
  if (!Number.isFinite(d.getTime())) return null
  return d.toISOString()
}
