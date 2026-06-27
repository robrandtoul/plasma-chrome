import { NavLink, Outlet } from 'react-router-dom'
import {
  BarChart3,
  Users,
  Building2,
  Layers,
  SlidersHorizontal,
  PoundSterling,
  Clock,
  Tag,
  Truck,
  Receipt,
  PackageSearch,
  ListChecks,
  Palette,
  AlertCircle,
  ClipboardList,
  MessageSquareText,
  PenLine,
  Sparkles,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { DesignerChrome } from '../../design'

// Sub-nav for the admin area — a left sidebar (screen 06) rather than
// a top tab strip. NavLinks pick up routing-aware active styling. Each
// row carries a Lucide icon per the handoff. Add entries here to extend
// the shell.
const TABS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/materials', label: 'Materials', icon: Layers },
  { to: '/admin/material-options', label: 'Material options', icon: SlidersHorizontal },
  { to: '/admin/pricing', label: 'Pricing', icon: PoundSterling },
  { to: '/admin/lead-times', label: 'Lead times', icon: Clock },
  { to: '/admin/card-weights', label: 'Card weights', icon: Tag },
  { to: '/admin/outsourcing', label: 'Outsourcing', icon: Truck },
  { to: '/admin/xero-item-codes', label: 'Xero item codes', icon: Receipt },
  { to: '/admin/xero-self-test', label: 'Xero self-test', icon: ListChecks },
  { to: '/admin/core-colours', label: 'Paper colours', icon: Palette },
  { to: '/admin/customers', label: 'Customers', icon: Building2 },
  { to: '/admin/orders', label: 'Order log', icon: PackageSearch },
  { to: '/admin/needs-attention', label: 'Follow-ups', icon: AlertCircle },
  { to: '/admin/activity', label: 'Activity', icon: ClipboardList },
  { to: '/admin/templates', label: 'Templates', icon: MessageSquareText },
  { to: '/admin/site-copy', label: 'Site copy', icon: PenLine },
  { to: '/admin/ai-drafts', label: 'AI drafts', icon: Sparkles },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
]

export default function AdminLayout() {
  // DesignerChrome owns the wordmark + global nav pills + user pill +
  // sign-out + edit-profile (PR 31). The admin sub-nav is a left
  // sidebar below it (PR 38). active="admin" highlights the Admin nav
  // pill; the sidebar highlights the current admin section.
  return (
    <DesignerChrome active="admin">
      <div className="min-h-dvh bg-canvas">
        <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          {/* Admin sidebar — vertical list at lg+, horizontally
              scrollable strip below lg so it doesn't eat vertical
              space on phones. Sticky at lg+ so it stays in view while
              the editor scrolls. */}
          <aside className="mb-6 lg:mb-0 lg:sticky lg:top-6 lg:self-start">
            <div className="eyebrow text-ink-mute mb-2 px-2.5 hidden lg:block">Admin</div>
            <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
              {TABS.map(({ to, label, icon: Icon }) => (
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
