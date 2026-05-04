import { Link } from 'react-router-dom'
import Modal from '../../components/Modal'
import { ACTION_LABELS } from './auditFilters'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  actor_id: string | null
  actor_email: string | null
  actor_label: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  before_value: unknown
  after_value: unknown
  metadata: unknown
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function absolute(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function relative(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 60_000
  if (diff < 1) return 'just now'
  if (diff < 60) return `${Math.floor(diff)} min ago`
  const h = diff / 60
  if (h < 24) return `${Math.floor(h)} hour${Math.floor(h) === 1 ? '' : 's'} ago`
  const days = h / 24
  return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} ago`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** URL for a target if we know how to link it. */
function targetUrl(entry: AuditEntry): string | null {
  if (!entry.target_id || !entry.target_type) return null
  switch (entry.target_type) {
    case 'user': return `/admin/users`
    case 'proof': return `/proofs/${entry.target_id}`
    default: return null
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AuditEntryModal({ entry, onClose }: {
  entry: AuditEntry
  onClose: () => void
}) {
  const label = ACTION_LABELS[entry.action] ?? entry.action
  const link = targetUrl(entry)
  const titleId = `audit-entry-title-${entry.id}`

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabelledBy={titleId}
      panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-gray-900">{label}</h3>
          <p className="mt-0.5 text-xs text-gray-500" title={absolute(entry.created_at)}>
            {absolute(entry.created_at)} · {relative(entry.created_at)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="ml-4 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          aria-label="Close"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="space-y-5 overflow-y-auto px-6 py-5">
        {/* Actor */}
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Actor</h4>
          <dl className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Label</dt>
              <dd className="text-right font-medium text-gray-900">{entry.actor_label ?? '—'}</dd>
            </div>
            {entry.actor_email && entry.actor_email !== entry.actor_label && (
              <div className="mt-1 flex justify-between gap-4">
                <dt className="text-gray-500">Email</dt>
                <dd className="text-right text-gray-700">{entry.actor_email}</dd>
              </div>
            )}
            {entry.actor_id && (
              <div className="mt-1 flex justify-between gap-4">
                <dt className="text-gray-500">ID</dt>
                <dd className="text-right">
                  <Link to="/admin/users" className="font-mono text-xs text-gray-500 hover:underline">
                    {entry.actor_id.slice(0, 8)}…
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </section>

        {/* Target */}
        {entry.target_type && (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Target</h4>
            <dl className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Type</dt>
                <dd className="text-right font-mono text-xs text-gray-700">{entry.target_type}</dd>
              </div>
              {entry.target_label && (
                <div className="mt-1 flex justify-between gap-4">
                  <dt className="text-gray-500">Label</dt>
                  <dd className="text-right font-medium text-gray-900">{entry.target_label}</dd>
                </div>
              )}
              {entry.target_id && (
                <div className="mt-1 flex justify-between gap-4">
                  <dt className="text-gray-500">ID</dt>
                  <dd className="text-right">
                    {link
                      ? <Link to={link} className="font-mono text-xs text-gray-500 hover:underline">{entry.target_id.slice(0, 8)}…</Link>
                      : <span className="font-mono text-xs text-gray-500">{entry.target_id.slice(0, 8)}…</span>}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* Diff */}
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Change</h4>
          <DiffView before={entry.before_value} after={entry.after_value} />
        </section>

        {/* Metadata */}
        {isObject(entry.metadata) && Object.keys(entry.metadata).length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Metadata</h4>
            <dl className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
              {Object.entries(entry.metadata).map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-4 py-0.5">
                  <dt className="font-mono text-xs text-gray-500">{k}</dt>
                  <dd className="max-w-[60%] break-all text-right text-sm text-gray-700">{formatValue(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Modal>
  )
}

// ── Diff rendering ───────────────────────────────────────────────────────────

function DiffView({ before, after }: { before: unknown; after: unknown }) {
  if (before == null && after == null) {
    return <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-500">No data changes recorded.</p>
  }
  if (before == null && after != null) {
    return <CreateOrDeleteView label="Created with values" value={after} />
  }
  if (before != null && after == null) {
    return <CreateOrDeleteView label="Deleted with values" value={before} />
  }
  // Both present — field-by-field diff.
  const b = isObject(before) ? before : { value: before }
  const a = isObject(after)  ? after  : { value: after }
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
  // Single-field short form, e.g. "Designer → Admin".
  if (keys.length === 1) {
    const k = keys[0]
    const bv = formatValue(b[k])
    const av = formatValue(a[k])
    return (
      <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
        <div className="text-xs text-gray-400">{k}</div>
        <div className="mt-1 text-gray-900"><span className="text-gray-500 line-through">{bv}</span>{'  →  '}<span className="font-medium">{av}</span></div>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-gray-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left">
            <th className="px-3 py-2 font-semibold text-gray-500">Field</th>
            <th className="px-3 py-2 font-semibold text-gray-500">Before</th>
            <th className="px-3 py-2 font-semibold text-gray-500">After</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const bv = formatValue(b[k])
            const av = formatValue(a[k])
            const changed = bv !== av
            return (
              <tr key={k} className="border-b border-gray-50 last:border-0">
                <td className="px-3 py-1.5 font-mono text-[11px] text-gray-500">{k}</td>
                <td className={['px-3 py-1.5 tabular-nums', changed ? 'text-rose-700 line-through' : 'text-gray-500'].join(' ')}>{bv}</td>
                <td className={['px-3 py-1.5 tabular-nums', changed ? 'font-medium text-emerald-700' : 'text-gray-500'].join(' ')}>{av}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CreateOrDeleteView({ label, value }: { label: string; value: unknown }) {
  const obj = isObject(value) ? value : { value }
  return (
    <div>
      <p className="mb-2 text-xs text-gray-500">{label}:</p>
      <dl className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
        {Object.entries(obj).map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-0.5">
            <dt className="font-mono text-xs text-gray-500">{k}</dt>
            <dd className="max-w-[60%] break-all text-right text-sm text-gray-700">{formatValue(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
