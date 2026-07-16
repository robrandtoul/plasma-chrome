import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import Modal from './Modal'
import { searchAdminDestinations, type AdminDestination } from '../lib/adminSearch'
import { ADMIN_ICONS, ADMIN_FALLBACK_ICON } from '../pages/admin/adminIcons'

// The "Search admin…" command palette. Opened from the box at the top of the
// admin sidebar or the "/" shortcut (both wired in AdminLayout). Type a word —
// exact name, partial, synonym, or a near-miss — and it fuzzy-ranks the admin
// pages + deep-linkable sections (src/lib/adminSearch.ts), then navigates.
//
// Built on the shared Modal so it inherits the focus-trap, body-scroll-lock,
// Escape-to-close and focus-return-to-trigger the app standardised on. The
// interaction is the standard combobox: focus stays in the input, ↑/↓ move a
// highlighted option, ↵ opens it. Options are role="option" (not buttons) so
// they never steal focus from the input.

// Cap the ranked list so the palette stays a focused "find THE feature" tool
// rather than a wall. Browsing (empty query) shows the whole directory.
const RESULT_LIMIT = 10

interface AdminSearchProps {
  open: boolean
  onClose: () => void
}

export default function AdminSearch({ open, onClose }: AdminSearchProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const trimmed = query.trim()
  const results = useMemo(() => searchAdminDestinations(query), [query])
  const items = trimmed ? results.slice(0, RESULT_LIMIT) : results

  // Fresh start every time it opens — the previous query shouldn't linger.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    if (active > items.length - 1) setActive(0)
  }, [items.length, active])

  // Scroll the highlighted row into view on keyboard navigation.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open, query])

  function go(d: AdminDestination) {
    onClose()
    navigate(d.path)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(items.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[active]
      if (it) go(it.destination)
    }
    // Escape is handled by Modal.
  }

  // Group headers only in browse mode; a per-row group breadcrumb in search
  // mode. Tracked across the map so headers land at each group boundary.
  let lastGroup: string | null = null

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Search admin features"
      mobileSheet={false}
      panelClassName="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl ring-1 ring-line self-start mt-[7vh] max-h-[78vh]"
    >
      {/* Input row */}
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={18} aria-hidden="true" className="shrink-0 text-ink-mute" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="admin-search-listbox"
          aria-activedescendant={items[active] ? `admin-search-opt-${active}` : undefined}
          aria-label="Search admin features"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search admin features…"
          className="h-12 w-full bg-transparent text-[15px] text-ink placeholder:text-ink-dim focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setActive(0)
            }}
            aria-label="Clear search"
            className="shrink-0 rounded-md p-1 text-ink-mute hover:bg-canvas hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Results */}
      <div id="admin-search-listbox" role="listbox" ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {items.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-ink">
              No admin features match &ldquo;{trimmed}&rdquo;.
            </p>
            <p className="mt-1 text-xs text-ink-mute">
              Try a shorter word, or a synonym — for example &ldquo;reminders&rdquo; or &ldquo;prices&rdquo;.
            </p>
          </div>
        ) : (
          items.map((r, i) => {
            const d = r.destination
            const Icon = ADMIN_ICONS[d.icon] ?? ADMIN_FALLBACK_ICON
            const showHeader = !trimmed && d.group !== lastGroup
            lastGroup = d.group
            const isActive = i === active
            return (
              <div key={d.id}>
                {showHeader && (
                  <div className="eyebrow px-4 pb-1 pt-3 text-ink-mute first:pt-1">{d.group}</div>
                )}
                <div
                  id={`admin-search-opt-${i}`}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  // onMouseMove, not onMouseEnter: a stationary cursor left
                  // hovering the list must NOT hijack the highlight when the
                  // list re-renders under it (which fires a synthetic
                  // mouseenter) — that would fight keyboard navigation. Real
                  // pointer movement still highlights the row under it.
                  onMouseMove={() => { if (!isActive) setActive(i) }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(d)}
                  className={[
                    // Single highlight concept: the "active" row. Keyboard
                    // (↑/↓) and real mouse movement both drive it, so there's
                    // never a second, competing hover tint.
                    'mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2',
                    isActive ? 'bg-brand-50' : '',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                      isActive ? 'bg-brand-100 text-brand-700' : 'bg-canvas text-ink-mute',
                    ].join(' ')}
                  >
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{d.label}</span>
                    {d.description && (
                      <span className="block truncate text-xs text-ink-mute">{d.description}</span>
                    )}
                  </span>
                  {trimmed && <span className="shrink-0 text-[11px] text-ink-dim">{d.group}</span>}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Footer hint */}
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-mute">
        <span className="flex items-center gap-1">
          <kbd className={KBD}>↑</kbd>
          <kbd className={KBD}>↓</kbd>
          <span>to move</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className={KBD}>↵</kbd>
          <span>to open</span>
        </span>
        <span className="hidden items-center gap-1 sm:flex">
          <kbd className={KBD}>esc</kbd>
          <span>to close</span>
        </span>
        <span className="ml-auto tabular-nums">
          {items.length} {items.length === 1 ? 'result' : 'results'}
        </span>
      </div>
    </Modal>
  )
}

const KBD =
  'inline-flex min-w-[18px] items-center justify-center rounded border border-line bg-canvas px-1 py-0.5 font-sans text-[10px] leading-none text-ink-mute'
