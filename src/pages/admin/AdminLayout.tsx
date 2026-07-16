import { NavLink, Outlet } from 'react-router-dom'
import {
  BarChart3,
  Users,
  Building2,
  Layers,
  PoundSterling,
  Table2,
  Truck,
  PackageSearch,
  MapPin,
  AlertCircle,
  ClipboardList,
  PenLine,
  Sparkles,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { DesignerChrome } from '../../design'

// Sub-nav for the admin area — a left sidebar (screen 06) rather than
// a top tab strip. Grouped by job (2026-07 admin nav cleanup), ordered
// roughly by how often each group is used: monitoring first, set-and-
// forget config last. On mobile the groups flatten into one horizontal
// strip (labels hidden) so the nav stays a single swipeable row.
//
// Keep the list short: a new per-material value goes on the Catalogue
// data page as a tab, a new toggle goes in Settings — only a genuinely
// new JOB earns a sidebar entry here.
const GROUPS: { label: string; tabs: { to: string; label: string; icon: LucideIcon }[] }[] = [
  {
    label: 'Performance',
    tabs: [{ to: '/admin/analytics', label: 'Analytics', icon: BarChart3 }],
  },
  {
    label: 'Customers & orders',
    tabs: [
      { to: '/admin/customers', label: 'Customers', icon: Building2 },
      { to: '/admin/orders', label: 'Order log', icon: PackageSearch },
      { to: '/admin/shipping', label: 'Shipping', icon: MapPin },
      { to: '/admin/outsourcing', label: 'Outsourcing', icon: Truck },
    ],
  },
  {
    label: 'Messaging & automation',
    tabs: [
      { to: '/admin/needs-attention', label: 'Follow-ups', icon: AlertCircle },
      { to: '/admin/ai-drafts', label: 'AI drafts', icon: Sparkles },
      { to: '/admin/content', label: 'Content', icon: PenLine },
    ],
  },
  {
    label: 'Catalogue',
    tabs: [
      { to: '/admin/materials', label: 'Materials', icon: Layers },
      { to: '/admin/pricing', label: 'Pricing', icon: PoundSterling },
      { to: '/admin/catalogue', label: 'Catalogue data', icon: Table2 },
    ],
  },
  {
    label: 'System',
    tabs: [
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/activity', label: 'Activity', icon: ClipboardList },
    ],
  },
]

export default function AdminLayout() {
  // DesignerChrome owns the wordmark + global nav pills + user pill +
  // sign-out + edit-profile (PR 31). The admin sub-nav is a left
  // sidebar below it (PR 38). active="admin" highlights the Admin nav
  // pill; the sidebar highlights the current admin section. NavLink's
  // default prefix matching keeps "Content" / "Catalogue data" lit on
  // their sub-tab URLs (/admin/content/messages etc.).
  return (
    <DesignerChrome active="admin">
      <div className="min-h-dvh bg-canvas">
        <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          {/* Admin sidebar — grouped vertical list at lg+, horizontally
              scrollable flat strip below lg so it doesn't eat vertical
              space on phones. Sticky at lg+ so it stays in view while
              the editor scrolls. `contents` lets the group wrappers
              dissolve into the flex row on mobile. */}
          <aside className="mb-6 lg:mb-0 lg:sticky lg:top-6 lg:self-start">
            <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0">
              {GROUPS.map((group, gi) => (
                <div key={group.label} className="contents lg:block">
                  <div className={`eyebrow text-ink-mute mb-1.5 px-2.5 hidden lg:block ${gi === 0 ? '' : 'lg:mt-5'}`}>
                    {group.label}
                  </div>
                  <div className="contents lg:flex lg:flex-col lg:gap-0.5">
                    {group.tabs.map(({ to, label, icon: Icon }) => (
                      <NavLink
                        key={to}
                        to={to}
                        className={({ isActive }) =>
                          [
                            'inline-flex items-center gap-2.5 whitespace-nowrap rounded-[8px] px-2.5 py-2 text-[13px] transition-colors',
                            isActive
                              ? 'bg-surface border border-line text-ink'
                              : 'border border-transparent text-ink-mute hover:bg-surface hover:text-ink',
                          ].join(' ')
                        }
                      >
                        <Icon size={15} aria-hidden="true" className="shrink-0" />
                        {label}
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          {/* Page content */}
          <main className="min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </DesignerChrome>
  )
}
