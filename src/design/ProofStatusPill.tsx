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
//   dormant    quietest grey (matches bg-canvas / text-ink-mute)
//   abandoned  notch stronger grey (matches bg-line / text-ink-soft)
// Both dormant and abandoned remain muted; abandoned is a step
// darker, mirroring how the live pill differentiates them.
const STATUS_MAP: Record<ProofStatus, StatusEntry> = {
  in_progress: { label: 'In review', cls: 'text-allocated bg-allocated-soft' },
  approved: { label: 'Approved', cls: 'text-in-stock bg-in-stock-soft' },
  dormant: { label: 'Dormant', cls: 'text-ink-dim bg-line-soft' },
  abandoned: { label: 'Abandoned', cls: 'text-ink-mute bg-line' },
}

interface ProofStatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  status?: ProofStatus
  /** Override the default label (e.g. append "on 27 May", or a workflow-bucket label). */
  label?: string
  /**
   * When set, render a soft pill in this CSS colour (token var or hex)
   * instead of the status-derived Tailwind classes. This is how the
   * dashboard + detail pages drive the pill from the workflow buckets
   * (proofBucket) so its label and colour match the headline tiles.
   */
  colour?: string
}

export function ProofStatusPill({ status, label, colour, className = '', ...rest }: ProofStatusPillProps) {
  // Bucket-driven path: caller passes a label + the bucket's CSS colour;
  // we render a soft pill (14% tint background + solid text), the same
  // idiom the stat tiles and avatar badges use.
  if (colour) {
    const cls = ['pill', className].filter(Boolean).join(' ')
    return (
      <span
        className={cls}
        style={{ color: colour, background: `color-mix(in srgb, ${colour} 14%, transparent)` }}
        {...rest}
      >
        {label}
      </span>
    )
  }
  // Legacy status path (kept for the design demo + any raw-status caller).
  const entry = STATUS_MAP[status ?? 'in_progress']
  const cls = ['pill', entry.cls, className].filter(Boolean).join(' ')
  return (
    <span className={cls} {...rest}>
      {label ?? entry.label}
    </span>
  )
}

export default ProofStatusPill
