import { Navigate, NavLink, useParams } from 'react-router-dom'
import AdminTemplatesSection from './AdminTemplatesSection'
import AdminSiteCopyPage from './AdminSiteCopyPage'

// /admin/content/:tab — everything customers read, in one place:
// the reply-template editor (previously /admin/templates) and the
// editable page copy (previously /admin/site-copy). Old URLs redirect
// here from App.tsx. URL-backed tabs so deep links keep working.

const TABS: { slug: string; label: string }[] = [
  { slug: 'messages', label: 'Messages' },
  { slug: 'site-copy', label: 'Site copy' },
]

export default function AdminContentPage() {
  const { tab } = useParams()
  if (!TABS.some((t) => t.slug === tab)) {
    return <Navigate to="/admin/content/messages" replace />
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Content</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Everything customers read — the message bodies we send, and the editable wording on the customer-facing pages. Changes save automatically.
        </p>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <NavLink
            key={t.slug}
            to={`/admin/content/${t.slug}`}
            className={({ isActive }) =>
              [
                'whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
                isActive ? 'border-[var(--c-brand)] text-ink font-medium' : 'border-transparent text-ink-mute hover:text-ink',
              ].join(' ')
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      {tab === 'messages' && (
        <div className="space-y-6">
          <p className="text-sm text-ink-mute">
            The message bodies sent to customers — designer-composed proof messages, automatic confirmations, and needs-attention reminders.
          </p>
          <AdminTemplatesSection />
        </div>
      )}
      {tab === 'site-copy' && <AdminSiteCopyPage />}
    </div>
  )
}
