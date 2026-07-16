import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Search, Home } from 'lucide-react'
import { DesignerChrome } from '../../design'
import AdminSearch from '../../components/AdminSearch'
import { ADMIN_NAV_GROUPS } from '../../lib/adminSearch'
import { ADMIN_ICONS, ADMIN_FALLBACK_ICON } from './adminIcons'

// Sub-nav for the admin area — a left sidebar (screen 06) rather than
// a top tab strip. Grouped by job (2026-07 admin nav cleanup), ordered
// roughly by how often each group is used: monitoring first, set-and-
// forget config last. On mobile the groups flatten into one horizontal
// strip (labels hidden) so the nav stays a single swipeable row.
//
// The groups + tabs are derived from ADMIN_NAV_GROUPS (src/lib/adminSearch.ts)
// so the sidebar and the "Search admin…" palette read from ONE list and can't
// drift. Add a page there once — set `sidebar: true` and it appears here too.
//
// Keep the list short: a new per-material value goes on the Catalogue
// data page as a tab, a new toggle goes in Settings — only a genuinely
// new JOB earns a sidebar entry.

// Passed down through the Outlet so the Admin home hub's search prompt opens
// the same palette as the sidebar box / "/" shortcut. Consumed via
// useOutletContext<AdminOutletContext>() in AdminHomePage.
export interface AdminOutletContext {
  openSearch: () => void
}

// Shared class for every sidebar link (Home + the grouped tabs).
function navTabClass(isActive: boolean): string {
  return [
    'inline-flex items-center gap-2.5 whitespace-nowrap rounded-[8px] px-2.5 py-2 text-[13px] transition-colors',
    isActive
      ? 'bg-surface border border-line text-ink'
      : 'border border-transparent text-ink-mute hover:bg-surface hover:text-ink',
  ].join(' ')
}

export default function AdminLayout() {
  const [searchOpen, setSearchOpen] = useState(false)

  // "/" opens the feature search from anywhere in the admin area (the
  // discoverable path is the search box at the top of the sidebar). Guarded
  // like useQuoteShortcut so typing "/" in a field never hijacks — and once
  // the palette is open, focus sits in its own input, so the guard keeps
  // subsequent slashes as ordinary text. Scoped to admin because the listener
  // only lives while this layout is mounted.
  useEffect(() => {
    function isEditable(el: Element | null): boolean {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(document.activeElement)) return
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // DesignerChrome owns the wordmark + global nav pills + user pill +
  // sign-out + edit-profile (PR 31). The admin sub-nav is a left
  // sidebar below it (PR 38). active="admin" highlights the Admin nav
  // pill; the sidebar highlights the current admin section. NavLink's
  // default prefix matching keeps "Content" / "Catalogue data" lit on
  // their sub-tab URLs (/admin/content/messages etc.). "Home" uses `end`
  // so it only lights on the /admin index (the hub), not every admin route.
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
            {/* Feature search — opens the command palette. Discoverable
                (always visible) and keyboard-first (the "/" hint). Full
                width above the nav on every breakpoint. */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="mb-3 flex w-full items-center gap-2 rounded-[8px] border border-line bg-surface px-2.5 py-2 text-[13px] text-ink-mute transition-colors hover:border-ink-dim hover:text-ink"
            >
              <Search size={15} aria-hidden="true" className="shrink-0" />
              <span className="flex-1 text-left">Search admin…</span>
              <kbd className="hidden rounded border border-line px-1 py-0.5 text-[10px] leading-none lg:inline">/</kbd>
            </button>

            <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0">
              {/* Home / overview hub — the /admin landing. First item, no
                  group heading; a little gap before the first group on desktop. */}
              <NavLink to="/admin" end className={({ isActive }) => `${navTabClass(isActive)} lg:mb-3`}>
                <Home size={15} aria-hidden="true" className="shrink-0" />
                Home
              </NavLink>

              {ADMIN_NAV_GROUPS.map((group) => (
                <div key={group.label} className="contents lg:block">
                  <div className="eyebrow text-ink-mute mb-1.5 px-2.5 hidden lg:block lg:mt-5">
                    {group.label}
                  </div>
                  <div className="contents lg:flex lg:flex-col lg:gap-0.5">
                    {group.tabs.map(({ to, label, icon }) => {
                      const Icon = ADMIN_ICONS[icon] ?? ADMIN_FALLBACK_ICON
                      return (
                        <NavLink key={to} to={to} className={({ isActive }) => navTabClass(isActive)}>
                          <Icon size={15} aria-hidden="true" className="shrink-0" />
                          {label}
                        </NavLink>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          {/* Page content */}
          <main className="min-w-0">
            <Outlet context={{ openSearch: () => setSearchOpen(true) } satisfies AdminOutletContext} />
          </main>
        </div>
      </div>

      <AdminSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </DesignerChrome>
  )
}
