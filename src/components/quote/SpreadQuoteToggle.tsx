// Internal-only "Spread quote" toggle. When OFF, the existing
// single-quantity flow stays untouched. When ON, the quantity
// input swaps for a multi-entry chip field and the price column
// renders a results table instead of the headline.
//
// Used when a customer asks for a price across multiple
// quantities at once ("can I get a quote for 50, 100, 250 and
// 500?"). Sits flush above QuantityInput so the swap from one
// to the other reads as a single mode switch rather than two
// separate fields.
//
// Visually muted compared to the spec controls — it's a quiet
// presentation switch, not a pricing dimension. Same chip
// shape as FinishToggle so it doesn't introduce a new control
// vocabulary.
export function SpreadQuoteToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <label
        className={[
          'inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
          'focus-within:ring-2 focus-within:ring-violet-400 focus-within:ring-offset-1',
          disabled
            ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400'
            : value
              ? 'border-violet-200 bg-violet-50 text-violet-900'
              : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
        ].join(' ')}
      >
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="sr-only"
          aria-label="Spread quote across multiple quantities"
        />
        <span
          aria-hidden
          className={[
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
            value
              ? 'border-violet-600 bg-violet-600 text-white'
              : 'border-gray-300 bg-white',
          ].join(' ')}
        >
          {value && (
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2.5 6.5l2.5 2.5 5-5.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span>Spread quote across multiple quantities</span>
      </label>
    </div>
  )
}
