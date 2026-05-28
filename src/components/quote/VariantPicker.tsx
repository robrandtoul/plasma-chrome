import type { CSSProperties } from 'react'
import { type QuoteVariant, variantSectionLabel } from '../../lib/quote/types'

const selectedChipStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Variant chip group. Section heading reads "Thickness", "Ink count"
// or "Finish" depending on the chosen material's variant_type. The
// component returns null entirely when the active material is a
// default-variant family (carbon fibre, wood, acrylic) — no
// orphaned heading, no single-chip placeholder.
//
// `loading` lets the page skip rendering while the variants for a
// freshly-picked material are still in flight, which happens for
// every material change in commits 3+.
export function VariantPicker({
  variants,
  value,
  onChange,
  loading = false,
}: {
  variants: QuoteVariant[]
  value: string | null
  onChange: (id: string) => void
  loading?: boolean
}) {
  if (variants.length === 0) {
    if (!loading) return null
    return (
      <fieldset>
        <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
          Variant
        </legend>
        <p className="text-sm text-ink-dim">Loading variants…</p>
      </fieldset>
    )
  }

  // Default-variant materials emit a single 'default' variant from
  // the DB. We treat that as "no dimension to expose" and return
  // null so the form skips the section entirely. Cleaner than
  // rendering one disabled chip.
  if (variants.length === 1 && variants[0].variant_type === 'default') {
    return null
  }

  const label = variantSectionLabel(variants[0].variant_type)

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
        {label}
      </legend>
      <div className="flex flex-wrap gap-2">
        {variants.map((v) => {
          const selected = value === v.id
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onChange(v.id)}
              className={[
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                selected
                  ? 'border-transparent'
                  : 'border-line bg-surface text-ink-soft hover:bg-canvas',
              ].join(' ')}
              style={selected ? selectedChipStyle : undefined}
            >
              {v.display_name}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
