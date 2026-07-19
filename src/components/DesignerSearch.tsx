import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X, FolderOpen, CornerDownLeft } from 'lucide-react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { ProofStatusPill, type ProofStatus } from '../design'

// The designer command palette — ⌘K from any designer page.
//
// WHY THIS EXISTS. The admin shell has had a proper fuzzy palette ("/" →
// AdminSearch) for a while, so admins could jump to any feature by name. The
// designer side — the surface actually used all day — had nothing: the only
// search lived inline on two pages (dashboard, flagged) and was mouse-only,
// and the single global shortcut, ⌘K, opened the quote compiler in a new tab
// despite a "⌘ K" badge sitting inside the search box implying it focused
// search. This closes both halves: ⌘K now means what it means everywhere else,
// and it works from Orders, a proof, the quote compiler — anywhere.
//
// Proof search is server-side via dashboard_list(p_search), the same RPC the
// dashboard uses, so it reaches every proof including the archive rather than
// filtering whatever happens to be loaded.
//
// Built on the shared Modal for the focus-trap / scroll-lock / Escape
// behaviour, and mirrors AdminSearch's combobox interaction exactly (focus
// stays in the input, ↑/↓ move a highlighted option, ↵ opens it) so the two
// palettes feel like one tool.

const PROOF_LIMIT = 8
const DEBOUNCE_MS = 250

interface PageDestination {
  kind: 'page'
  id: string
  label: string
  hint: string
  path: string
  keywords: string
}

// Kept deliberately short — this is "get me to the right place", not a
// directory. Admin has its own palette for the deep stuff.
const PAGES: PageDestination[] = [
  { kind: 'page', id: 'proofs',   label: 'Proofs',         hint: 'Dashboard',              path: '/',          keywords: 'dashboard home projects list' },
  { kind: 'page', id: 'new',      label: 'New project',    hint: 'Start a proof',          path: '/proofs/new', keywords: 'create add start proof job' },
  { kind: 'page', id: 'orders',   label: 'Orders',         hint: 'Pay links and ordering', path: '/orders',    keywords: 'payment pay link invoice place' },
  { kind: 'page', id: 'quote',    label: 'Quote compiler', hint: 'Price a job',            path: '/quote',     keywords: 'price pricing cost shipping estimate' },
  { kind: 'page', id: 'flagged',  label: 'Flagged',        hint: 'Problem projects',       path: '/flagged',   keywords: 'complaint issue watch problem' },
  { kind: 'page', id: 'chat',     label: 'Chat',           hint: 'Team messages',          path: '/chat',      keywords: 'team message dm talk' },
  { kind: 'page', id: 'activity', label: 'Activity',       hint: 'Recent customer events', path: '/activity',  keywords: 'events feed latest history' },
  { kind: 'page', id: 'feedback', label: 'Feedback',       hint: 'Report a bug or idea',   path: '/feedback',  keywords: 'bug idea improvement suggest report' },
  { kind: 'page', id: 'admin',    label: 'Admin',          hint: 'Settings and catalogue', path: '/admin',     keywords: 'settings materials pricing users' },
]

interface ProofHit {
  kind: 'proof'
  proofId: string
  company: string | null
  contact: string | null
  material: string | null
  versionNumber: number | null
  status: ProofStatus | null
}

type Item = PageDestination | ProofHit

function matchesPage(p: PageDestination, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    p.label.toLowerCase().includes(needle) ||
    p.hint.toLowerCase().includes(needle) ||
    p.keywords.includes(needle)
  )
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function DesignerSearch({ open, onClose }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [proofs, setProofs] = useState<ProofHit[]>([])
  const [searching, setSearching] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Guards against a slow earlier query overwriting a newer one's results.
  const requestSeq = useRef(0)

  const trimmed = query.trim()

  // Fresh start every time it opens — a stale query from an hour ago is never
  // what the designer wants.
  useEffect(() => {
    if (open) {
      setQuery('')
      setProofs([])
      setActive(0)
      setSearching(false)
    }
  }, [open])

  // Debounced server-side proof search. Two characters minimum: a single
  // letter matches most of the book and costs a round trip to say so.
  useEffect(() => {
    if (!open) return
    if (trimmed.length < 2) {
      setProofs([])
      setSearching(false)
      return
    }
    setSearching(true)
    const seq = ++requestSeq.current
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('dashboard_list', { p_search: trimmed })
      // Ignore anything that isn't the newest in-flight request.
      if (seq !== requestSeq.current) return
      if (error) {
        console.error('[DesignerSearch] proof search failed', error)
        setProofs([])
        setSearching(false)
        return
      }
      const rows = (data ?? []) as Array<{
        proof_id: string
        company_name: string | null
        contact_name: string | null
        material_display: string | null
        current_version_number: number | null
        status: ProofStatus | null
      }>
      setProofs(rows.slice(0, PROOF_LIMIT).map((r) => ({
        kind: 'proof',
        proofId: r.proof_id,
        company: r.company_name,
        contact: r.contact_name,
        material: r.material_display,
        versionNumber: r.current_version_number,
        status: r.status,
      })))
      setSearching(false)
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [trimmed, open])

  const pageHits = useMemo(
    () => (trimmed ? PAGES.filter((p) => matchesPage(p, trimmed)) : PAGES),
    [trimmed],
  )

  // Proofs first when searching — the designer is far more often looking for a
  // job than for a page. Pages lead in browse mode, where there's nothing to
  // match against.
  const items: Item[] = useMemo(
    () => (trimmed ? [...proofs, ...pageHits] : pageHits),
    [trimmed, proofs, pageHits],
  )

  useEffect(() => {
    if (active > items.length - 1) setActive(0)
  }, [items.length, active])

  useEffect(() => {
    if (!open) return
    // Index 0 is already at the top of the list, and scrolling to it clips the
    // group header sitting above it. Only chase the highlight once it moves.
    if (active === 0) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open, query])

  function go(item: Item) {
    onClose()
    navigate(item.kind === 'page' ? item.path : `/proofs/${item.proofId}`)
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
      if (it) go(it)
    }
    // Escape is handled by Modal.
  }

  let lastKind: Item['kind'] | null = null

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Search projects and pages"
      mobileSheet={false}
      panelClassName="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl ring-1 ring-line self-start mt-[7vh] max-h-[78vh]"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={18} aria-hidden="true" className="shrink-0 text-ink-mute" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="designer-search-listbox"
          aria-activedescendant={items[active] ? `designer-search-opt-${active}` : undefined}
          aria-label="Search projects and pages"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search projects by customer, company or email…"
          className="h-12 w-full bg-transparent text-[15px] text-ink placeholder:text-ink-dim focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setActive(0) }}
            aria-label="Clear search"
            className="shrink-0 rounded-md p-1 text-ink-mute hover:bg-canvas hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        id="designer-search-listbox"
        role="listbox"
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        {items.length === 0 ? (
          <div className="px-6 py-10 text-center">
            {searching ? (
              <p className="text-sm text-ink-mute">Searching…</p>
            ) : (
              <>
                <p className="text-sm text-ink">Nothing matches &ldquo;{trimmed}&rdquo;.</p>
                <p className="mt-1 text-xs text-ink-mute">
                  Projects match on customer, company, email or Help Scout id — including
                  ones that have already been archived.
                </p>
              </>
            )}
          </div>
        ) : (
          items.map((item, i) => {
            const showHeader = item.kind !== lastKind
            lastKind = item.kind
            const isActive = i === active
            return (
              <div key={item.kind === 'page' ? `p-${item.id}` : `r-${item.proofId}`}>
                {showHeader && (
                  <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-ink-mute">
                    {item.kind === 'proof' ? 'Projects' : 'Go to'}
                  </p>
                )}
                <div
                  id={`designer-search-opt-${i}`}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item)}
                  className={`mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ${
                    isActive ? 'bg-canvas' : ''
                  }`}
                >
                  {item.kind === 'proof' ? (
                    <>
                      <FolderOpen size={16} aria-hidden="true" className="shrink-0 text-ink-mute" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {item.company ?? item.contact ?? 'Untitled project'}
                        </span>
                        <span className="block truncate text-xs text-ink-mute">
                          {[
                            item.company && item.contact ? item.contact : null,
                            item.material,
                            item.versionNumber ? `v${item.versionNumber}` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {item.status && <ProofStatusPill status={item.status} />}
                    </>
                  ) : (
                    <>
                      <CornerDownLeft size={16} aria-hidden="true" className="shrink-0 text-ink-mute" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{item.label}</span>
                        <span className="block truncate text-xs text-ink-mute">{item.hint}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-mute">
        <span>↑ ↓ to move</span>
        <span>↵ to open</span>
        <span>esc to close</span>
        {searching && items.length > 0 && <span className="ml-auto">Searching…</span>}
      </div>
    </Modal>
  )
}
