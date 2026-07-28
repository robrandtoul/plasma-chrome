// previous_spec — "what this customer ordered last time" (migration 000364).
//
// Server-side sanitiser for the previous_spec payload the order builder sends
// with create-order. The stored jsonb is CUSTOMER-VISIBLE by construction
// (public_get_order returns the whole orders row), so this is an allow-list:
// only the seven known display-safe keys survive, strings are trimmed and
// capped, and anything malformed degrades the whole object to null — guidance
// must never block order creation, and a hand-crafted request must not be able
// to smuggle arbitrary content onto the customer's pay page.
//
// Deliberately free of Deno globals so the src-side unit test can import it
// directly (the openSpecTiers.test.ts parity pattern) and cross-check it
// against the client's parser for drift.

export interface PreviousSpec {
  /** material_variants.id of the thickness they had — used to badge the matching card. */
  variant_id: string | null
  /** Frozen display label, e.g. "500 microns" — names the old spec even if the variant is later retired. */
  variant_label: string | null
  /** material_options.id of the finish they had. */
  option_id: string | null
  /** Frozen display label, e.g. "Brushed". */
  option_label: string | null
  /** Total cards on the previous order. */
  quantity: number | null
  /** Human "when", shown to the customer — e.g. "March 2022". */
  label: string | null
  /** How the designer established it: auto-suggested from order history, or entered by hand. */
  source: 'auto' | 'manual'
}

const capped = (value: unknown, cap: number): string | null => {
  if (typeof value !== 'string') return null
  let s = value.trim().slice(0, cap)
  // A cap landing inside an emoji leaves a lone high surrogate, which
  // Postgres jsonb REJECTS — and a rejected jsonb fails the whole orders
  // INSERT, breaking the "guidance never blocks order creation" promise.
  // Drop the orphan so the stored string is always well-formed.
  const last = s.charCodeAt(s.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  return s || null
}

/**
 * Validate an untrusted previous_spec payload down to the storable shape.
 * Returns null when there is nothing meaningful to show (no variant, finish,
 * or quantity) — a bare date label on its own guides nobody.
 */
export function sanitisePreviousSpec(raw: unknown): PreviousSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const variantId = capped(r.variant_id, 64)
  const variantLabel = capped(r.variant_label, 120)
  const optionId = capped(r.option_id, 64)
  const optionLabel = capped(r.option_label, 120)
  let quantity: number | null = null
  if (r.quantity != null) {
    const q = Number(r.quantity)
    if (Number.isInteger(q) && q > 0 && q <= 1_000_000) quantity = q
  }
  const label = capped(r.label, 60)
  const source: 'auto' | 'manual' = r.source === 'auto' ? 'auto' : 'manual'
  if (!variantId && !variantLabel && !optionId && !optionLabel && quantity == null) return null
  return {
    variant_id: variantId,
    variant_label: variantLabel,
    option_id: optionId,
    option_label: optionLabel,
    quantity,
    label,
    source,
  }
}
