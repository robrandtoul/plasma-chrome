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
    <fieldset className="rounded-lg border border-line bg-canvas p-4">
      {/* Heading sits inside the box as a <p>, not a <legend>. A
          fieldset legend always straddles the top border (it reads as
          colliding with it); this matches the "Special card types"
          section's inside-the-box heading instead. */}
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-mute">
        Internal discount
      </p>
      <p className="mb-2 mt-1 text-xs text-ink-mute">
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
            aria-label="Internal discount percentage"
            className={[
              'w-28 rounded-lg border px-3 py-2 pr-8 text-[17px] sm:text-sm tabular-nums shadow-sm',
              'focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1',
              isActive
                ? 'border-line bg-surface text-ink'
                : 'border-line bg-surface text-ink-soft',
            ].join(' ')}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ink-dim"
          >
            %
          </span>
        </div>
        {isActive && (
          <button
            type="button"
            onClick={() => onChange(0)}
            className="text-xs font-medium text-ink-mute underline-offset-2 hover:text-ink-soft hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </fieldset>
  )
}
