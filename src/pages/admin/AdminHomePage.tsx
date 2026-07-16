import { Link, useOutletContext } from 'react-router-dom'
import { Search } from 'lucide-react'
import { ADMIN_SIDEBAR_GROUPS } from '../../lib/adminSearch'
import { ADMIN_ICONS, ADMIN_FALLBACK_ICON } from './adminIcons'
import type { AdminOutletContext } from './AdminLayout'

// The /admin landing — a hub, not a redirect into a data page. Opening the
// admin area on Analytics left the first screen mostly empty (heading + tabs +
// a spinner) which read as broken; this gives a proper home: the feature
// search up top, then every admin section as a labelled card. Cards are built
// from ADMIN_SIDEBAR_GROUPS (src/lib/adminSearch.ts) — the same list that
// drives the sidebar and the search — so a new admin page shows up here
// automatically and nothing drifts. Deep sub-tabs / settings sections stay
// reachable through the search or by clicking into their section.

export default function AdminHomePage() {
  const { openSearch } = useOutletContext<AdminOutletContext>()

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-ink">Admin</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Everything behind the scenes. Jump to a section below, or search for a feature by name.
        </p>
      </div>

      {/* Search prompt — opens the same palette as the sidebar box and "/". */}
      <button
        type="button"
        onClick={openSearch}
        className="flex w-full max-w-xl items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left text-ink-mute transition-colors hover:border-ink-dim hover:text-ink"
      >
        <Search size={18} aria-hidden="true" className="shrink-0" />
        <span className="flex-1">Search admin features…</span>
        <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] leading-none sm:inline">/</kbd>
      </button>

      {ADMIN_SIDEBAR_GROUPS.map((group) => (
        <section key={group.label}>
          <h3 className="eyebrow mb-3 text-ink-mute">{group.label}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((d) => {
              const Icon = ADMIN_ICONS[d.icon] ?? ADMIN_FALLBACK_ICON
              return (
                <Link
                  key={d.id}
                  to={d.path}
                  className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-ink-dim hover:bg-canvas"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-mute transition-colors group-hover:bg-surface group-hover:text-ink">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink">{d.label}</span>
                    {d.description && (
                      <span className="mt-0.5 block text-xs text-ink-mute">{d.description}</span>
                    )}
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
