import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { QuoteLink } from '../../components/QuoteLink'

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
  const navigate = useNavigate()

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-dvh bg-gray-50">
      {/* Header — matches the designer dashboard's branding strip. */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">PlasmaDesign</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Admin</h1>
          </div>
          <div className="flex items-center gap-3">
            {/* QuoteLink lives in the per-page header on six pages today.
                Future "extract shared header" pass should inline this
                once and remove the per-page insertions. */}
            <QuoteLink />
            <Link
              to="/"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              ← Back to projects
            </Link>
            <button
              onClick={handleSignOut}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Sub-nav */}
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <nav className="-mb-px flex gap-6">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  [
                    'border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-gray-900 text-gray-900'
                      : 'border-transparent text-gray-500 hover:border-gray-200 hover:text-gray-900',
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
  )
}
