import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  type MaterialCategory,
  type QuoteMaterial,
} from '../../lib/quote/types'

const selectedChipStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Peer-pair groupings. Visual-only — the picker still produces
// individual material selections; the wrapper just signals the
// sibling relationship between paper_letterpress + paper_letterpress
// _gilded and carbon_fibre + carbon_fibre_cnc. Schema-level both
// rows stay independent.
const PEER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['paper_letterpress', 'paper_letterpress_gilded'],
  ['carbon_fibre', 'carbon_fibre_cnc'],
]

function findPeer(code: string): string | null {
  for (const [a, b] of PEER_PAIRS) {
    if (a === code) return b
    if (b === code) return a
  }
  return null
}
function isPeerLead(code: string): boolean {
  return PEER_PAIRS.some(([a]) => a === code)
}

// Family-grouped material picker. Type-to-filter input at the top
// (autofocused on mount) lets designers narrow down without
// hunting; substring match runs against both the material display
// name and the family label, so "metal" narrows to the metal rail
// just as "letter" narrows to letterpress + letterpress with
// gilding.
//
// Family sections lead with a divider rule + a bold uppercase
// label and a per-family count, so the eye locks onto the family
// before scanning chips. Empty families collapse out of view as
// the filter narrows.
//
// Peer materials (Letterpress / Letterpress with Gilding; Carbon
// Fibre / Carbon Fibre with CNC) render inside a subtle pair
// wrapper when both members survive the filter. If only one
// member matches, it falls back to a solo chip — the visual
// pairing is opportunistic, not load-bearing.
//
// Keyboard:
// - Input autofocuses on mount.
// - Escape on the input or any chip clears the query and
//   refocuses the input.
// - ArrowDown from the input → focuses the first visible chip.
// - ArrowDown / ArrowUp on a chip walks through visible chips in
//   document order.
// - Enter on a focused chip activates it (browser default for
//   buttons).
export function MaterialPicker({
  materials,
  value,
  onChange,
  isExpanded = true,
}: {
  materials: QuoteMaterial[]
  value: string | null
  onChange: (id: string) => void
  // Drives focus management. When the picker transitions from
  // collapsed to expanded, the search input refocuses so the
  // designer can immediately type to filter. The picker stays
  // mounted across collapse/expand (so the grid-template-rows
  // height animation has content to interpolate against), so we
  // can't rely on the mount-time focus alone.
  isExpanded?: boolean
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Autofocus the search input on mount and on every transition
  // to expanded. Initial /quote load: isExpanded defaults true,
  // input gets focused. Re-expand from a collapsed state: the
  // useEffect re-runs with isExpanded=true and refocuses.
  // Collapse path skips focus — the chip click already moved
  // focus elsewhere, and the input is hidden inside the
  // collapsed-height grid container.
  useEffect(() => {
    if (isExpanded) inputRef.current?.focus()
  }, [isExpanded])

  const q = query.trim().toLowerCase()
  const filteredBuckets = useMemo(() => {
    const buckets = new Map<MaterialCategory, QuoteMaterial[]>()
    for (const m of materials) {
      if (q) {
        const haystacks = [m.display_name, CATEGORY_LABEL[m.category]]
        const hit = haystacks.some((h) => h.toLowerCase().includes(q))
        if (!hit) continue
      }
      const list = buckets.get(m.category) ?? []
      list.push(m)
      buckets.set(m.category, list)
    }
    return buckets
  }, [materials, q])

  const totalVisible = useMemo(() => {
    let n = 0
    for (const list of filteredBuckets.values()) n += list.length
    return n
  }, [filteredBuckets])

  function focusFirstChip() {
    const first = containerRef.current?.querySelector<HTMLButtonElement>('button[data-material-chip]')
    first?.focus()
  }

  function handleInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && query !== '') {
      e.preventDefault()
      setQuery('')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusFirstChip()
    }
  }

  function handleChipKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>('button[data-material-chip]') ?? [],
    )
    const idx = all.indexOf(document.activeElement as HTMLButtonElement)
    if (idx === -1) return
    e.preventDefault()
    if (e.key === 'ArrowDown' && idx < all.length - 1) {
      all[idx + 1].focus()
    } else if (e.key === 'ArrowUp') {
      if (idx === 0) inputRef.current?.focus()
      else all[idx - 1].focus()
    }
  }

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
        Material
      </legend>

      <div className="mb-4">
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKey}
          placeholder="Type to filter materials…"
          aria-label="Filter materials"
          autoComplete="off"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm text-ink placeholder:text-ink-mute focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </div>

      <div ref={containerRef} onKeyDown={handleChipKey}>
        {totalVisible === 0 ? (
          <p className="text-sm text-ink-dim">
            No materials match {`"${query}"`}.
          </p>
        ) : (
          <div className="space-y-5">
            {CATEGORY_ORDER.map((cat) => {
              const list = filteredBuckets.get(cat)
              if (!list || list.length === 0) return null
              return (
                <FamilySection
                  key={cat}
                  cat={cat}
                  list={list}
                  value={value}
                  onChange={onChange}
                />
              )
            })}
          </div>
        )}
      </div>
    </fieldset>
  )
}

function FamilySection({
  cat,
  list,
  value,
  onChange,
}: {
  cat: MaterialCategory
  list: QuoteMaterial[]
  value: string | null
  onChange: (id: string) => void
}) {
  // Render order: walk the (already-sorted) list, splice peer pairs
  // into a wrapper when BOTH members are present, otherwise render
  // each material as a solo chip. We track consumed peers to skip
  // them on their own iteration.
  const consumed = new Set<string>()
  const codeToMaterial = new Map<string, QuoteMaterial>()
  for (const m of list) codeToMaterial.set(m.code, m)

  const items: React.ReactNode[] = []
  for (const m of list) {
    if (consumed.has(m.code)) continue
    const peerCode = findPeer(m.code)
    if (peerCode && codeToMaterial.has(peerCode) && isPeerLead(m.code)) {
      const peer = codeToMaterial.get(peerCode)!
      consumed.add(peer.code)
      items.push(
        <PeerPair
          key={`${m.code}__pair`}
          first={m}
          second={peer}
          value={value}
          onChange={onChange}
        />,
      )
    } else if (peerCode && codeToMaterial.has(peerCode) && !isPeerLead(m.code)) {
      // Pair lead is also visible and will pick this one up — skip.
      continue
    } else {
      items.push(
        <MaterialChip
          key={m.code}
          m={m}
          selected={value === m.id}
          onClick={() => onChange(m.id)}
        />,
      )
    }
  }

  return (
    <div className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <p className="mb-3 text-sm font-bold uppercase tracking-widest text-ink">
        {CATEGORY_LABEL[cat]}{' '}
        <span className="font-semibold text-ink-dim">({list.length})</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">{items}</div>
    </div>
  )
}

function MaterialChip({
  m,
  selected,
  onClick,
  inPair = false,
}: {
  m: QuoteMaterial
  selected: boolean
  onClick: () => void
  // Peer-pair chips have a slightly different rendering (no
  // outer border — the wrapper provides one) so the pair reads
  // as a single grouped affordance.
  inPair?: boolean
}) {
  return (
    <button
      type="button"
      data-material-chip
      onClick={onClick}
      className={[
        'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
        inPair
          ? selected
            ? 'border border-transparent'
            : 'border border-transparent bg-surface text-ink-soft hover:bg-canvas'
          : selected
            ? 'border border-transparent'
            : 'border border-line bg-surface text-ink-soft hover:bg-canvas',
      ].join(' ')}
      style={selected ? selectedChipStyle : undefined}
    >
      {m.display_name}
    </button>
  )
}

function PeerPair({
  first,
  second,
  value,
  onChange,
}: {
  first: QuoteMaterial
  second: QuoteMaterial
  value: string | null
  onChange: (id: string) => void
}) {
  // Subtle "pouch" wrapper that ties the two chips together
  // visually without competing with the violet selected styling.
  // Light gray fill + thin border + small inner gap = "these
  // belong together" read at a glance.
  return (
    <span
      aria-label={`${first.display_name} family`}
      className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-canvas p-0.5"
    >
      <MaterialChip
        m={first}
        selected={value === first.id}
        onClick={() => onChange(first.id)}
        inPair
      />
      <span aria-hidden className="px-0.5 text-xs font-medium text-ink-dim">+</span>
      <MaterialChip
        m={second}
        selected={value === second.id}
        onClick={() => onChange(second.id)}
        inPair
      />
    </span>
  )
}
