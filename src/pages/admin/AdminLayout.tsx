import { NavLink, Outlet } from 'react-router-dom'
import { DesignerChrome } from '../../design'

// Sub-nav tabs for the admin area. Rendered as NavLinks so the active tab
// picks up routing-aware styling. Add more entries here to extend the shell.
const TABS: { to: string; label: string }[] = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/customers', label: 'Customers' },
  { to: '/admin/materials', label: 'Materials' },
  { to: '/admin/pricing', label: 'Pricing' },
  { to: '/admin/lead-times', label: 'Lead times' },
  { to: '/admin/card-weights', label: 'Card weights' },
  { to: '/admin/core-colours', label: 'Paper colours' },
  { to: '/admin/needs-attention', label: 'Needs attention' },
  { to: '/admin/activity', label: 'Activity' },
  { to: '/admin/settings', label: 'Settings' },
]

export default function AdminLayout() {
  // DesignerChrome owns the wordmark + global nav pills + user pill +
  // sign-out + edit-profile (PR 31). The admin area's second-level tab
  // nav sits below it. active="admin" highlights the Admin nav pill;
  // the sub-nav highlights the current admin tab.
  return (
    <DesignerChrome active="admin">
      <div className="min-h-dvh bg-canvas">
        {/* Admin sub-nav — horizontally scrollable on narrow widths so
            the ten tabs don't wrap. Active tab gets an ink underline +
            ink text; idle tabs are ink-mute with a hairline hover. */}
        <div className="border-b border-line bg-surface">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <nav className="-mb-px flex gap-6 overflow-x-auto">
              {TABS.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  className={({ isActive }) =>
                    [
                      'whitespace-nowrap border-b-2 px-1 py-3 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'border-ink text-ink'
                        : 'border-transparent text-ink-mute hover:border-line hover:text-ink',
                    ].join(' ')
                  }
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>

        {/* Page content */}
        <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </DesignerChrome>
  )
}
