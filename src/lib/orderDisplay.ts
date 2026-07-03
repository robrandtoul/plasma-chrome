// Shared order-display helpers.
//
// The work queue (OrdersPage) and the admin Order log render the same order
// figures from two different data shapes — OrdersPage reads orders directly
// (nested joins), the log reads the flat `admin_search_orders` RPC payload.
// Keeping the total / spec / customer logic here means the two surfaces can't
// drift on a displayed total. Each helper takes the minimal fields it needs so
// either shape can adapt to it.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface OrderAmounts {
  custom_quote_total: number | null
  amount_card_discount: number | null
  amount_us_tariff: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
}

// The order's charged total, matching the Stripe charge + Xero invoice:
// the cards discount nets off either branch; shipping + the US tariff ride on
// top as their own charged lines. Null when there are no priced parts at all.
// Shipping is added in BOTH branches — a custom-quote order (incl. a prototype)
// still has carriage stamped at checkout and invoiced as its own line, so the
// displayed total must include it to match the Stripe charge.
export function orderTotal(o: OrderAmounts): number | null {
  const discount = Number(o.amount_card_discount ?? 0)
  const tariff = Number(o.amount_us_tariff ?? 0)
  if (o.custom_quote_total != null) return round2(Number(o.custom_quote_total) - discount + Number(o.amount_shipping ?? 0) + tariff)
  const parts = [o.amount_cards, o.amount_tooling, o.amount_personalisation, o.amount_shipping]
  if (parts.every((p) => p == null) && tariff === 0) return null
  return round2(parts.reduce((acc: number, p) => acc + Number(p ?? 0), 0) - discount + tariff)
}

// "Material · Variant · Finish", collapsing to just the material when the
// variant adds nothing, and to "Custom quote" when there's no material
// (custom-quote order). The finish (the order's material_option — metal
// Natural/Brushed/Mirror, plastic Gloss/Matte) is appended when pinned or
// picked; an open-spec order the customer hasn't resolved yet simply omits
// it, same as an unpicked thickness.
export function specLabel(
  materialDisplay: string | null | undefined,
  variantDisplay: string | null | undefined,
  customQuoteTotal: number | null,
  optionDisplay?: string | null,
): string {
  const material = (materialDisplay ?? '').trim()
  const variant = (variantDisplay ?? '').trim()
  const option = (optionDisplay ?? '').trim()
  // Skip the finish when it just repeats the variant — standard paper's
  // finish-type variants (Standard / UV Spot / Foiling) surface the variant
  // name as `finish` in admin_search_orders, and "· With Foiling · With
  // Foiling" would read as a bug.
  const optionSuffix = option && option !== variant ? ` · ${option}` : ''
  if (customQuoteTotal != null && !material) return 'Custom quote'
  if (variant && variant !== material) return `${material} · ${variant}${optionSuffix}`.replace(/^ · /, '')
  return material ? `${material}${optionSuffix}` : 'Custom quote'
}

// Company name first, falling back to the contact name, then an em dash.
export function customerLabel(
  companyName: string | null | undefined,
  contactName: string | null | undefined,
): string {
  return companyName?.trim() || contactName?.trim() || '—'
}
