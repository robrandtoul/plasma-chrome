import type { CSSProperties } from 'react'
import type { QuoteMaterialOption } from '../../lib/quote/types'

const selectedChipStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Optional finish picker for materials that bill a quantity-tiered
// surcharge for non-base options. Today this means Steel and Gold
// with their Brushed and Mirror upgrades — the base option
// (Natural) is the no-surcharge default. Wood species also live
// in material_options but carry no surcharge rows, so the
// QuotePage hide-rule keeps this component out of view there.
//
// Visual shape mirrors the variant chips: a chip group, with the
// base option always leftmost and the surcharged options after,
// in sort_order. The selection key is the option's `code` so
// price lookups stay readable.
export function FinishToggle({
  label,
  options,
  value,
  onChange,
}: {
  // Singular section heading from materials.option_label, e.g.
  // "Finish" for Steel/Gold. Falls back to "Finish" if the column
  // is null on a surcharged material — shouldn't happen today but
  // belt-and-braces.
  label: string | null
  options: readonly QuoteMaterialOption[]
  value: string
  onChange: (code: string) => void
}) {
  if (options.length === 0) return null

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
        {label ?? 'Finish'}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const selected = value === o.code
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.code)}
              className={[
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                selected
                  ? 'border-transparent'
                  : 'border-line bg-surface text-ink-soft hover:bg-canvas',
              ].join(' ')}
              style={selected ? selectedChipStyle : undefined}
            >
              {o.display_name}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
