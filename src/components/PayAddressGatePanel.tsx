// The "which postcode is right?" panel — shown on both pay pages between the
// card form and the Pay button when the Address Element's value disagrees
// with the destination the order was rated for (src/lib/payAddressGate.ts).
//
// Deliberately an inline panel, not a modal: it sits where the customer is
// already looking, next to the address it questions, and it never hard-blocks
// — a customer who insists their address is right proceeds with one click
// (having been asked once). The one case that can't proceed as-quoted is a
// pricing-band change, where the only honest continue is a requote.

import { countryName, type AddressGateState } from '../lib/payAddressGate'

interface Props {
  gate: AddressGateState
  onUseAddress: () => void
  onEditAddress: () => void
  onReprice: () => void
}

export function PayAddressGatePanel({ gate, onUseAddress, onEditAddress, onReprice }: Props) {
  const enteredBits = [gate.entered.line1, gate.entered.city, gate.entered.postcode]
    .filter(Boolean)
    .join(', ')
  const enteredDisplay = enteredBits || countryName(gate.entered.country)
  const ratedDisplay = gate.ratedPostcode || countryName(gate.ratedCountry)
  return (
    <div role="alert" className="mt-3 rounded-xl border border-out bg-out-soft p-4">
      <p className="text-sm font-semibold text-ink">Quick check before we take payment</p>
      {gate.repriceNeeded ? (
        <>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            We quoted delivery for <strong className="text-ink">{ratedDisplay}</strong>, but the address
            you&rsquo;ve entered — <strong className="text-ink">{enteredDisplay}</strong>
            {gate.entered.country !== gate.ratedCountry ? ` (${countryName(gate.entered.country)})` : ''} — is in a
            different delivery region, so the delivery cost needs requoting before you pay.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onReprice}
              className="inline-flex items-center justify-center rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-on-ink transition-opacity hover:opacity-90"
            >
              Requote for this address
            </button>
            <button
              type="button"
              onClick={onEditAddress}
              className="text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Let me check the address
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            The postcode you gave us for delivery (<strong className="text-ink">{ratedDisplay}</strong>) doesn&rsquo;t
            match the address you&rsquo;ve just entered (<strong className="text-ink">{enteredDisplay}</strong>).
            Which is right?
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onUseAddress}
              className="inline-flex items-center justify-center rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-on-ink transition-opacity hover:opacity-90"
            >
              Deliver to this address
            </button>
            <button
              type="button"
              onClick={onEditAddress}
              className="text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Let me check the address
            </button>
          </div>
        </>
      )}
    </div>
  )
}
