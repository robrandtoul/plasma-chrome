// Customer order (pay-page) URL helpers.
//
// The customer-facing pay-page will live at /order/:id and is gated by
// a per-order bearer token in the query string. The page itself ships
// in Step 4 (Stripe Checkout); this helper exists now so the order
// builder can show and copy the link the moment an order is created.
//
// Centralised (like customerProofUrl.ts) so a later change to the
// token mechanism — rename the param, move it into the path — touches
// one file.

export function customerOrderPath(orderId: string, token: string): string {
  return `/order/${orderId}?token=${encodeURIComponent(token)}`
}

export function customerOrderUrl(orderId: string, token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${customerOrderPath(orderId, token)}`
}
