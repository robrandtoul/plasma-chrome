// Shared types + presentational helpers for the Customers admin area.
// Used by both the lean company list (CustomersPage) and the per-company
// detail page (CustomerDetailPage). Pure presentation — no data fetching
// or mutation lives here.

import { Link } from 'react-router-dom'
import Modal from '../../components/Modal'
import { relativeTime } from '../../lib/relativeTime'
import type { ProofStatus } from '../../lib/types'

export interface ProjectLite {
  proof_id: string
  status: ProofStatus
  contact_id: string | null
  contact_name: string | null
  company_id: string | null
  company_name: string | null
  current_version_number: number | null
  material_display: string | null
  last_activity_at: string | null
}

export function statusLabel(status: ProofStatus): string {
  if (status === 'approved') return 'Approved'
  if (status === 'dormant') return 'Dormant'
  if (status === 'abandoned') return 'Abandoned'
  return 'In progress'
}

export function StatusDot({ status }: { status: ProofStatus }) {
  // Status dot colour follows the dashboard tile + row palette:
  // approved → in-stock, abandoned → ink-mute, dormant → ink-dim,
  // in_progress → allocated (matches the "In review" pill).
  const colour =
    status === 'approved' ? 'var(--c-in-stock)'
      : status === 'dormant' ? 'var(--c-ink-dim)'
        : status === 'abandoned' ? 'var(--c-ink-mute)'
          : 'var(--c-allocated)'
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: colour }}
    />
  )
}

// Row label. With showContact we lead with the contact name (the
// disambiguator when a company's projects span several contacts);
// otherwise we lead with the company name.
function projectTitle(p: ProjectLite, showContact: boolean): string {
  if (showContact) return p.contact_name || '(no contact)'
  return p.company_name || p.contact_name || '(no contact)'
}

// One row per proof; rows link to the proof detail page. Newest activity
// first (projects with no last_activity_at fall to the end).
export function ProjectList({ projects, showContact, className }: {
  projects: ProjectLite[]
  showContact?: boolean
  className?: string
}) {
  if (projects.length === 0) {
    return (
      <div className={['rounded-xl bg-canvas px-4 py-3 text-xs text-ink-mute', className ?? ''].join(' ')}>
        No matching projects to show.
      </div>
    )
  }
  const ordered = [...projects].sort((a, b) => {
    const av = a.last_activity_at ?? ''
    const bv = b.last_activity_at ?? ''
    if (av === bv) return 0
    if (!av) return 1
    if (!bv) return -1
    return bv.localeCompare(av)
  })
  return (
    <div className={['overflow-hidden rounded-xl bg-white border border-line', className ?? ''].join(' ')}>
      {ordered.map((p, i) => (
        <Link
          key={p.proof_id}
          to={`/proofs/${p.proof_id}`}
          className={[
            'flex items-center gap-3 px-4 py-2 text-xs hover:bg-canvas',
            i > 0 ? 'border-t border-line-soft' : '',
          ].join(' ')}
        >
          <StatusDot status={p.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-ink">
              {projectTitle(p, !!showContact)}
              {p.current_version_number != null && (
                <span className="ml-2 text-xs text-ink-mute">v{p.current_version_number}</span>
              )}
            </div>
            {p.material_display && (
              <div className="truncate text-xs text-ink-mute">{p.material_display}</div>
            )}
          </div>
          <span className="shrink-0 text-xs text-ink-mute">{statusLabel(p.status)}</span>
          <span className="shrink-0 text-xs text-ink-mute">
            {p.last_activity_at ? relativeTime(p.last_activity_at) : ''}
          </span>
        </Link>
      ))}
    </div>
  )
}

// Compact native-select dropdown with a chevron. Mirrors the DashboardPage
// SelectField so the visual language stays consistent across admin tools.
export function SelectField<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="relative inline-flex items-center rounded-md border border-line bg-surface hover:bg-canvas focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)]">
      {label && (
        <span className="pointer-events-none select-none pl-2.5 text-xs font-medium text-ink-mute">
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-xs font-medium text-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
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

export function ConfirmDialog({
  message,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: {
  message: string
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel="Confirm delete"
      panelClassName="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
    >
      <p className="text-sm text-ink-soft">{message}</p>
      {errorMsg && (
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{errorMsg}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={working}
          className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={working}
          className="rounded bg-out px-4 py-2 text-sm font-semibold text-on-out hover:opacity-90 disabled:opacity-50"
        >
          {working ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  )
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function isValidEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value)
}
