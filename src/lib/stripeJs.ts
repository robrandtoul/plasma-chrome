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

export interface StripeElementLike {
  mount: (selector: string) => void
  unmount?: () => void
  // Link / address elements emit a 'change' event carrying the entered value.
  // We listen on the Link element to capture the buyer's email.
  on?: (event: string, handler: (e: { value?: { email?: string } }) => void) => void
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
