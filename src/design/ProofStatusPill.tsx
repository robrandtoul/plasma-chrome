import { type HTMLAttributes } from 'react'

// Live four-status set from src/lib/types.ts. The handoff originally
// proposed a seven-state widening (draft/awaiting/reviewing/changes/
// snoozed/approved/archived); REVISIONS.md decision 2 defers that as
// a product change, so the pill uses the four real statuses.
export type ProofStatus = 'in_progress' | 'approved' | 'dormant' | 'abandoned'

interface StatusEntry {
  label: string
  /** Tailwind utility classes for the pill body (text + bg). */
  cls: string
}

// Hierarchy preserved from the production styling in ProofDetailPage:
//   in_progress was amber → now allocated-blue ("In review")
//   approved   stays green
//   dormant    quietest grey (matches bg-gray-100 / text-gray-500)
//   abandoned  notch stronger grey (matches bg-slate-200 / text-slate-700)
// Both dormant and abandoned remain muted; abandoned is a step
// darker, mirroring how the live pill differentiates them.
const STATUS_MAP: Record<ProofStatus, StatusEntry> = {
  in_progress: { label: 'In review', cls: 'text-allocated bg-allocated-soft' },
  approved: { label: 'Approved', cls: 'text-in-stock bg-in-stock-soft' },
  dormant: { label: 'Dormant', cls: 'text-ink-dim bg-line-soft' },
  abandoned: { label: 'Abandoned', cls: 'text-ink-mute bg-line' },
}

interface ProofStatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  status: ProofStatus
  /** Override the default label (e.g. append "on 27 May"). */
  label?: string
}

export function ProofStatusPill({ status, label, className = '', ...rest }: ProofStatusPillProps) {
  const entry = STATUS_MAP[status]
  const cls = ['pill', entry.cls, className].filter(Boolean).join(' ')
  return (
    <span className={cls} {...rest}>
      {label ?? entry.label}
    </span>
  )
}

export default ProofStatusPill
