// Internal discount % input — designer-only price modifier. Reduces
// the headline total, the Copy-quote output, and every spread row's
// total by the entered percentage. Resets to 0 on every material
// change (see QuotePage's useEffect block) so a forgotten discount
// can't silently follow the designer onto a different product.
//
// The control accepts decimals (12.5% is meaningful), clamps to
// 0–100 at the input layer, and stays mounted at zero so the
// designer can flick it on/off without the layout jumping. A small
// "Clear" affordance appears once the value is non-zero — quicker
// than backspacing through the number.

export function DiscountInput({
  value,
  onChange,
}: {
  value: number
  onChange: (next: number) => void
}) {
  const isActive = value > 0
  return (
    <fieldset className="rounded-lg border border-gray-200 bg-gray-50/60 p-4">
      <legend className="block px-1 text-xs font-semibold uppercase tracking-widest text-gray-500">
        Internal discount
      </legend>
      <p className="mb-2 text-xs text-gray-500">
        Optional. Reduces the headline price, copy-quote total, and
        spread-quote totals by this percentage. Resets when the
        material changes.
      </p>
      <div className="flex items-center gap-3">
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.5}
            value={Number.isFinite(value) && value > 0 ? value : ''}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') {
                onChange(0)
                return
              }
              const parsed = Number(raw)
              if (Number.isNaN(parsed)) return
              if (parsed < 0) {
                onChange(0)
                return
              }
              if (parsed > 100) {
                onChange(100)
                return
              }
              onChange(parsed)
            }}
            placeholder="0"
            className={[
              'w-28 rounded-lg border px-3 py-2 pr-8 text-[17px] sm:text-sm tabular-nums shadow-sm',
              'focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1',
              isActive
                ? 'border-gray-400 bg-white text-gray-900'
                : 'border-gray-200 bg-white text-gray-700',
            ].join(' ')}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-gray-400"
          >
            %
          </span>
        </div>
        {isActive && (
          <button
            type="button"
            onClick={() => onChange(0)}
            className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </fieldset>
  )
}
