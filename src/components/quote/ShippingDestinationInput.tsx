import { SHIPPING_COUNTRIES } from '../../lib/quote/countries'

// Destination inputs for the Quote compiler's FedEx shipping card.
// Two fields — country (curated select) and postcode (free text).
// Origin is fixed (Plasma, SO510QJ / GB) so only the destination
// half is in the form.
//
// Empty country = no destination chosen; the parent withholds the
// rate fetch until both are populated. Postcode is uppercased on
// blur so cache-key normalisation in the edge function and the
// admin readout agree.

export function ShippingDestinationInput({
  country,
  postcode,
  onCountryChange,
  onPostcodeChange,
  disabled = false,
}: {
  country: string | null
  postcode: string | null
  onCountryChange: (next: string | null) => void
  onPostcodeChange: (next: string | null) => void
  disabled?: boolean
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-mute">
        Shipping destination
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-mute">Country</span>
          <select
            value={country ?? ''}
            onChange={(e) => onCountryChange(e.target.value === '' ? null : e.target.value)}
            disabled={disabled}
            className="select-styled rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-dim"
          >
            <option value="">Select country…</option>
            {SHIPPING_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-mute">Postcode</span>
          <input
            type="text"
            value={postcode ?? ''}
            onChange={(e) => onPostcodeChange(e.target.value === '' ? null : e.target.value)}
            onBlur={() => {
              if (postcode && postcode !== postcode.toUpperCase()) {
                onPostcodeChange(postcode.toUpperCase())
              }
            }}
            disabled={disabled}
            placeholder="e.g. 10001"
            className="w-40 rounded-lg border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-dim"
          />
        </label>
      </div>
      <p className="mt-1.5 text-xs text-ink-mute">
        Origin is Plasma's Southampton premises. Destination drives the FedEx rate lookup; designer-only.
      </p>
    </div>
  )
}
