// Designer-only view switch at the top of the Quote compiler's price
// column. Three states:
//
//   * product   — hide the shipping card; show product price only
//   * shipping  — hide the product headline + adjacent strips;
//                 show shipping only
//   * both      — default; show everything
//
// Lives outside the Selection card because it controls what's
// rendered on the right (price column), not what the designer is
// inputting on the left. Same chip vocabulary as the FinishToggle
// so the control reads as a presentation switch, not a pricing
// dimension.

export type QuoteView = 'product' | 'shipping' | 'both'

export function QuoteViewToggle({
  value,
  onChange,
}: {
  value: QuoteView
  onChange: (next: QuoteView) => void
}) {
  const options: Array<{ value: QuoteView; label: string }> = [
    { value: 'product', label: 'Product' },
    { value: 'shipping', label: 'Shipping' },
    { value: 'both', label: 'Both' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Quote view"
      className="inline-flex rounded-lg bg-canvas p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={[
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-mute hover:text-ink',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
