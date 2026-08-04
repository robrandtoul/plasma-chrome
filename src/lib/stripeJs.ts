// Stripe.js loader + the minimal Elements types the pay pages use.
//
// Extracted verbatim from OrderPayPage so the group pay page (bundle orders
// Slice 2) mounts the identical secure payment form — one copy of the
// PCI-relevant loading code, not two drifting ones.
//
// Stripe.js must load from Stripe's CDN (never bundled, for PCI); we resolve
// the global factory, loading the script once and reusing it. The types are
// deliberately minimal shapes of the bits of Elements we use — avoids a
// bundled @stripe/stripe-js dependency.

const STRIPE_JS_SRC = 'https://js.stripe.com/v3/'

export function loadStripeJs(): Promise<((key: string) => StripeLike) | null> {
  const w = window as unknown as { Stripe?: (key: string) => StripeLike }
  if (w.Stripe) return Promise.resolve(w.Stripe)
  return new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${STRIPE_JS_SRC}"]`) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(w.Stripe ?? null))
      existing.addEventListener('error', () => resolve(null))
      if (w.Stripe) resolve(w.Stripe)
      return
    }
    const s = document.createElement('script')
    s.src = STRIPE_JS_SRC
    s.async = true
    s.onload = () => resolve(w.Stripe ?? null)
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
}

// The Address Element's value shape — what getValue() resolves with, and what
// `defaultValues` accepts when creating the element (so a captured value can
// re-seed a remounted form after a reprice).
export interface StripeAddressValue {
  name?: string
  address?: {
    line1?: string
    line2?: string
    city?: string
    state?: string
    postal_code?: string
    country?: string
  }
  phone?: string
}

export interface StripeElementLike {
  mount: (selector: string) => void
  unmount?: () => void
  // Link / address elements emit a 'change' event carrying the entered value.
  // We listen on the Link element to capture the buyer's email.
  on?: (event: string, handler: (e: { value?: { email?: string } }) => void) => void
  // Address element only: read the current value + completeness on demand
  // (the real Stripe.js API). The delivery-postcode gate calls this at Pay
  // time; optional so the other element types keep the same shape.
  getValue?: () => Promise<{ complete?: boolean; value?: StripeAddressValue }>
}
export interface StripeElementsLike {
  create: (type: string, options?: Record<string, unknown>) => StripeElementLike
}
export interface StripeConfirmResult {
  error?: { message?: string }
}
export interface StripeLike {
  elements: (options: { clientSecret: string; appearance?: Record<string, unknown> }) => StripeElementsLike
  confirmPayment: (options: {
    elements: StripeElementsLike
    // receipt_email must be passed explicitly — Stripe does NOT auto-promote the
    // Link element's email onto the PaymentIntent. Without it the webhook gets a
    // null email and the Xero VAT invoice can't be sent.
    confirmParams: { return_url: string; receipt_email?: string }
  }) => Promise<StripeConfirmResult>
}
