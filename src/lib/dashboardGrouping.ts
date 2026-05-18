// Dashboard grouping utilities extracted from DashboardPage.tsx so they can
// be unit-tested independently of the React component tree.

import type { ProofStatus } from './types'

export type DesignerColour = 'blue' | 'teal' | 'coral' | 'purple'

export type NeedsAttentionRule =
  | 'request_changes_no_version'
  | 'helpscout_follow_up_tag'
  | 'sent_never_viewed'
  | 'viewed_not_actioned'
  | 'approaching_dormant'
  | 'stuck_in_progress'

export interface DashboardProject {
  proof_id: string
  created_at: string
  last_activity_at: string
  status: ProofStatus
  approved_at: string | null
  abandoned_at: string | null
  disclaimer_acknowledged_at: string | null
  helpscout_conversation_url: string | null
  helpscout_conversation_id: string | null
  contact_id: string | null
  contact_name: string | null
  contact_email: string | null
  company_id: string | null
  company_name: string | null
  current_version_id: string | null
  current_version_number: number | null
  material_display: string | null
  version_created_at: string | null
  designer_user_id: string | null
  designer_name: string | null
  designer_initials: string | null
  designer_colour: DesignerColour | null
  designer_avatar_url: string | null
  latest_event_at: string | null
  latest_event_type: 'approve' | 'request_changes' | 'view' | 'designer_override_approve' | null
  latest_event_actor: string | null
  current_version_viewed_at: string | null
  rule_code: NeedsAttentionRule | null
  rule_meta: { days?: number } | null
  snooze_rule_code: NeedsAttentionRule | null
  snoozed_until: string | null
  snooze_note: string | null
  snoozed_by_name: string | null
  snoozed_by_initials: string | null
  snoozed_by_colour: DesignerColour | null
}

export type SectionKind = 'pinned' | 'team' | 'snoozed' | 'time' | 'company'

export interface ProjectSection {
  key: string
  title: string
  kind: SectionKind
  projects: DashboardProject[]
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function startOfToday(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

export function isSameDay(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  return t.getFullYear() === s.getFullYear()
      && t.getMonth()    === s.getMonth()
      && t.getDate()     === s.getDate()
}

export function isThisWeek(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  const diffDays = Math.floor(
    (s.getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000
  )
  return diffDays > 0 && diffDays < 7
}

// ── Snooze state helpers ──────────────────────────────────────────────────────
//
// public_dashboard_projects (000186) carries snoozed_until forward for 24
// hours after a snooze expires so the dashboard can bucket recently-awakened
// proofs back into Today. The frontend therefore can't read
// `snoozed_until != null` as "this proof is currently snoozed" any more —
// it has to also check the timestamp is in the future. Wrapping that check
// in a helper keeps the same predicate consistent across the tile counts,
// the click-through filters, and the Snoozed-section grouping.

/**
 * Returns true when the proof has a snooze row whose snoozed_until is still
 * in the future. False for recently-awakened proofs (snoozed_until in the
 * 24-hour grace window) and for proofs that were never snoozed.
 */
export function isCurrentlySnoozed(p: DashboardProject): boolean {
  if (!p.snoozed_until) return false
  return new Date(p.snoozed_until).getTime() > Date.now()
}

/**
 * Returns true when the proof's snooze expired within the last 24 hours.
 * These proofs are bucketed in Today regardless of last_activity_at, since
 * the designer hasn't had a chance to act on them since they woke up.
 */
export function recentlyAwakened(p: DashboardProject): boolean {
  if (!p.snoozed_until) return false
  const expiry = new Date(p.snoozed_until).getTime()
  const now    = Date.now()
  return expiry <= now && expiry >= now - 24 * 60 * 60 * 1000
}

// ── Grouping functions ────────────────────────────────────────────────────────

export function groupByTime(projects: DashboardProject[]): ProjectSection[] {
  const today: DashboardProject[] = []
  const week:  DashboardProject[] = []
  const older: DashboardProject[] = []
  for (const p of projects) {
    const ts = p.last_activity_at
    if (!ts) {
      older.push(p)
      continue
    }
    if (recentlyAwakened(p) || isSameDay(ts)) today.push(p)
    else if (isThisWeek(ts))                  week.push(p)
    else                                       older.push(p)
  }
  const out: ProjectSection[] = []
  if (today.length) out.push({ key: 'today', title: 'Today',     kind: 'time', projects: today })
  if (week.length)  out.push({ key: 'week',  title: 'This week', kind: 'time', projects: week  })
  if (older.length) out.push({ key: 'older', title: 'Older',     kind: 'time', projects: older })
  return out
}

export function groupByCompany(projects: DashboardProject[]): ProjectSection[] {
  const map = new Map<string, ProjectSection>()
  for (const p of projects) {
    const key   = p.company_id ?? '__individual__'
    const title = p.company_name ?? 'No company'
    if (!map.has(key)) map.set(key, { key, title, kind: 'company', projects: [] })
    map.get(key)!.projects.push(p)
  }
  const sections   = [...map.values()]
  const individual = sections.find((s) => s.key === '__individual__')
  const named      = sections.filter((s) => s.key !== '__individual__')
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  return individual ? [...named, individual] : named
}

export function buildSnoozedSection(projects: DashboardProject[]): ProjectSection[] {
  const snoozed = projects.filter(isCurrentlySnoozed)
  if (!snoozed.length) return []
  return [{ key: '__snoozed__', title: 'Snoozed', kind: 'snoozed', projects: snoozed }]
}
