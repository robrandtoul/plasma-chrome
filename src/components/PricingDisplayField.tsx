export type PricingDisplayValue = 'standard' | 'custom'

export function PricingDisplayField({
  value,
  onChange,
  invalid = false,
  forwardRef,
}: {
  value: PricingDisplayValue | null
  onChange: (value: PricingDisplayValue) => void
  invalid?: boolean
  forwardRef?: React.RefObject<HTMLElement | null>
}) {
  return (
    <section
      ref={forwardRef as React.RefObject<HTMLElement>}
      className={[
        'rounded-2xl bg-white p-6 shadow-sm ring-1',
        invalid ? 'ring-rose-300' : 'ring-gray-200',
      ].join(' ')}
    >
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Pricing display</h2>
      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="sr-only">Choose how pricing is shown to the customer</legend>
        <OptionCard
          label="Standard pricing"
          description="Customer sees a price grid based on material and quantity."
          value="standard"
          checked={value === 'standard'}
          onChange={() => onChange('standard')}
        />
        <OptionCard
          label="Custom quote"
          description="Pricing is hidden. Customer sees a note saying you'll quote separately."
          value="custom"
          checked={value === 'custom'}
          onChange={() => onChange('custom')}
        />
      </fieldset>
      {invalid && <p className="mt-3 text-xs font-medium text-rose-500">Required</p>}
    </section>
  )
}

function OptionCard({
  label,
  description,
  value,
  checked,
  onChange,
}: {
  label: string
  description: string
  value: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label
      className={[
        'relative flex cursor-pointer flex-col rounded-xl border-2 p-4 transition-colors',
        'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
        checked
          ? 'border-gray-900 bg-gray-50'
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
      ].join(' ')}
    >
      <input
        type="radio"
        name="pricing-display"
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold text-gray-900">{label}</span>
        {checked && (
          <svg className="h-4 w-4 shrink-0 text-gray-900" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l3.5 3.5 6.5-7" />
          </svg>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">{description}</p>
    </label>
  )
}
