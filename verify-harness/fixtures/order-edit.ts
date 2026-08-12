// Fixtures for the EDIT ORDER modal (?path=/order-edit) in the verify harness.
//
// Owned by the order-edit e2e work — mock-supabase.ts delegates to this hook
// FIRST and falls through to its own fixtures when it returns null. The
// contract that keeps parallel work safe: only claim requests that belong to
// THIS area's fixture ids (prefix `oe-`), return null for everything else.
// That includes the catalogue rows, so nothing here can perturb the shared
// steel/metal fixtures the order-builder rig reads.
//
// The modal's complete data surface, derived from EditOrderModal.tsx:
//
//   orders           .eq('id', <orderId>).maybeSingle() — the whole editable row
//   material_variants .eq('id', <the order's variant>)  — material + variant_type
//                                                          (drives the artwork-
//                                                          pinned read-only lock)
//   material_variants .eq('material_id', …).eq('is_active', true) — the picker list
//   price_tiers      head count per variant × currency  — GRID orders only
//   material_options .eq('material_id', …)              — the finish pills
//   materials        .eq('id', …) select option_label   — the picker's label
//   proof_versions   — NOT claimed: only read when names_count > 1, and both
//                      fixture orders are single-recipient, so the per-person
//                      split path never runs.
//   invoke update-order — NOT claimed: the shared mock's generic { ok: true }
//                      fallback is exactly the success shape the modal wants.
//
// The fixture material is Full Colour Plastic because that is the material the
// real incident happened on (ORD-96E1B49E8B, The Rowborough Estate, £329
// agreed): its gloss/matte finish is preference-only, so it never appears on
// the proof's artwork tabs and the order row is the ONLY record of which one
// the customer is getting.

import type { HookQueryState } from './customer-proof'

const oe = (v: unknown): v is string => typeof v === 'string' && v.startsWith('oe-')

// Three real Full Colour Plastic thicknesses. 760 micron is deliberately
// UNPRICED in GBP: the grid path filters variants down to those with a price
// tier, the agreed-price path does not, so the two orders must show a
// different number of choices. That difference is what proves the tier filter
// is still applied where it belongs, rather than having been lifted for
// everyone along with the picker.
const VARIANTS = [
  { id: 'oe-mv-420', display_name: '420 micron', sort_order: 1, variant_type: 'thickness', material_id: 'oe-m-fcp', priced: true },
  { id: 'oe-mv-680', display_name: '680 micron', sort_order: 2, variant_type: 'thickness', material_id: 'oe-m-fcp', priced: true },
  { id: 'oe-mv-760', display_name: '760 micron', sort_order: 3, variant_type: 'thickness', material_id: 'oe-m-fcp', priced: false },
]

const OPTIONS = [
  { id: 'oe-mo-gloss', display_name: 'Gloss', is_base: true, sort_order: 1 },
  { id: 'oe-mo-matte', display_name: 'Matte', is_base: false, sort_order: 2 },
]

function order(id: string, customQuoteTotal: number | null) {
  return {
    id,
    proof_id: 'oe-proof',
    status: 'sent',
    order_kind: 'production',
    currency: 'GBP',
    custom_quote_total: customQuoteTotal,
    material_id: 'oe-m-fcp',
    material_variant_id: 'oe-mv-680',
    // The finish the order was created with — the field the incident had to be
    // corrected in by hand. Pre-selected, so a spec that asserts a DIFFERENT
    // pill can be chosen is asserting a real change of state.
    material_option_id: 'oe-mo-gloss',
    quantity: 500,
    names_count: 1,
    person_quantities: null,
    card_discount_type: 'none',
    card_discount_value: null,
    card_discount_reason: null,
    token: 'oe-tok',
  }
}

const ORDERS: Record<string, ReturnType<typeof order>> = {
  // The regression case: an agreed price on a standard-priced proof, which is
  // the shape PR #615 made reachable from the builder and this modal could not
  // then correct.
  'oe-agreed': order('oe-agreed', 329),
  // The unchanged case, same material and currency, priced from the grid.
  'oe-grid': order('oe-grid', null),
  // An agreed price whose material carries no variants at all — the only shape
  // where a variant-less order is legitimate, so Save must not demand a pick.
  'oe-agreed-novariants': { ...order('oe-agreed-novariants', 329), material_id: 'oe-m-bare', material_variant_id: null },
}

export function orderEditQuery(state: HookQueryState): { data: any; error: null; count?: number } | null {
  const { table, select, single, filters } = state

  if (table === 'orders') {
    const id = filters['eq:id']
    if (!oe(id)) return null
    return { data: ORDERS[id] ?? null, error: null }
  }

  if (table === 'material_variants') {
    // The order's own variant: material + variant_type, read to resolve the
    // material and decide whether the artwork pins the variant read-only.
    const id = filters['eq:id']
    if (oe(id)) {
      const v = VARIANTS.find((r) => r.id === id) ?? null
      return { data: v ? { material_id: v.material_id, variant_type: v.variant_type } : null, error: null }
    }
    // The picker list.
    const materialId = filters['eq:material_id']
    if (oe(materialId)) {
      const rows = VARIANTS.filter((v) => v.material_id === materialId).map((v) => ({
        id: v.id, display_name: v.display_name, sort_order: v.sort_order, variant_type: v.variant_type,
      }))
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length }
    }
    return null
  }

  if (table === 'price_tiers') {
    const variantId = filters['eq:material_variant_id']
    if (!oe(variantId)) return null
    // Read head-only, so only the count is consulted.
    const priced = VARIANTS.find((v) => v.id === variantId)?.priced === true
    return { data: [], error: null, count: priced ? 1 : 0 }
  }

  if (table === 'material_options') {
    const materialId = filters['eq:material_id']
    if (!oe(materialId)) return null
    const rows = materialId === 'oe-m-fcp' ? OPTIONS : []
    return { data: rows, error: null, count: rows.length }
  }

  if (table === 'materials' && select.includes('option_label')) {
    const id = filters['eq:id']
    if (!oe(id)) return null
    return { data: { option_label: 'Finish' }, error: null }
  }

  return null
}
