import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import type { Currency } from '../types'
import type { PriceTier } from './calculate'
import type { QuoteMaterialOption } from './types'

export interface PricingData {
  // Per-variant tier rows in the chosen currency. Empty Map while
  // a fetch is in flight or before any material is picked. After
  // a successful fetch every variant of the chosen material gets
  // an entry, even ones with no rows (e.g. 5–8 ink letterpress
  // tiers in some currencies) so the consumer can distinguish
  // "loaded, no prices" from "still loading".
  tiersByVariantId: Map<string, PriceTier[]>
  // material_options for the chosen material (sorted by
  // sort_order), plus the per-(option × quantity) surcharge map
  // resolved for the active currency. Empty when the material has
  // no options. The FinishToggle hides itself when no option in
  // the set has any surcharge rows in the active currency, so
  // option-but-no-surcharge materials (wood species, etc.) stay
  // silent.
  options: QuoteMaterialOption[]
  surchargesByOptionId: Map<string, Record<number, number>>
  loading: boolean
  // Surface the currency the loaded tiers were fetched in. Lets
  // QuotePage avoid a stale-render flash when the user switches
  // currency: the consumer can compare against its own selection
  // and treat any mismatch as still-loading.
  loadedCurrency: Currency | null
  loadedMaterialId: string | null
}

const EMPTY: PricingData = {
  tiersByVariantId: new Map(),
  options: [],
  surchargesByOptionId: new Map(),
  loading: false,
  loadedCurrency: null,
  loadedMaterialId: null,
}

// Live price-tier + option-surcharge fetcher for the quote
// compiler. Three round trips on material change (tiers + options
// + option surcharges), all parallel; same set re-fetched on
// currency change. Zero fetches on variant or quantity change —
// variant + quantity navigation looks up against the in-memory
// maps this hook returns.
//
// The brief's "always hit the live DB" rule is satisfied by the
// ephemeral nature of the cache: it lives only on the component
// instance, dies on unmount, and re-fetches on every reload of
// /quote. Within a single page load we don't re-fetch on every
// keystroke, so the sub-100ms response budget is comfortable.
//
// Tier fetch joins through material_variants so a single query
// returns every tier for every variant of the chosen material.
// Option surcharges fetch separately because they're keyed on
// option_id, not variant_id, and it's cleaner than nesting two
// PostgREST joins.
export function usePricing(
  materialId: string | null,
  currency: Currency | null,
): PricingData {
  const [data, setData] = useState<PricingData>(EMPTY)
  // Drop stale results: if the user toggles currency while a
  // previous request is still in flight, we want the second
  // response to win regardless of which one resolves first. A
  // ref-tracked request id keeps that simple without depending
  // on cleanup ordering.
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!materialId || !currency) {
      setData(EMPTY)
      return
    }

    const id = ++requestIdRef.current
    // Unmount guard. requestIdRef alone protects against stale
    // results landing in a still-mounted component, but if the
    // component unmounts mid-fetch, setData would still run on
    // the unmounted instance. The cleanup below sets `cancelled`
    // and the resolved-promise handler bails before any setState.
    let cancelled = false
    setData((prev) => ({ ...prev, loading: true }))

    const tiersPromise = supabase
      .from('material_variants')
      .select('id, price_tiers(quantity, total_price, currency)')
      .eq('material_id', materialId)
      .eq('is_active', true)
      .eq('price_tiers.currency', currency)

    const optionsPromise = supabase
      .from('material_options')
      .select('id, code, display_name, is_base, sort_order')
      .eq('material_id', materialId)
      .order('sort_order')

    Promise.all([tiersPromise, optionsPromise]).then(async ([tiersResult, optionsResult]) => {
      if (cancelled || id !== requestIdRef.current) return // unmounted or stale

      const tiersMap = new Map<string, PriceTier[]>()
      for (const row of (tiersResult.data ?? []) as Array<{
        id: string
        price_tiers: Array<{ quantity: number; total_price: number; currency: string }>
      }>) {
        const tiers: PriceTier[] = (row.price_tiers ?? [])
          .map((t) => ({
            variantId: row.id,
            quantity: t.quantity,
            // Numeric columns come back as strings via PostgREST
            // when precision matters. Coerce to Number once here
            // so consumers don't have to remember.
            totalPrice: Number(t.total_price),
          }))
          .sort((a, b) => a.quantity - b.quantity)
        tiersMap.set(row.id, tiers)
      }

      const options = (optionsResult.data ?? []) as QuoteMaterialOption[]

      // Second-stage fetch for option surcharges, gated on
      // there being any options at all. Same currency filter as
      // the tier query so we never read another currency's data
      // by accident.
      let surchargesByOptionId = new Map<string, Record<number, number>>()
      if (options.length > 0) {
        const { data: surchargeRows } = await supabase
          .from('material_option_surcharges')
          .select('material_option_id, quantity, surcharge')
          .in('material_option_id', options.map((o) => o.id))
          .eq('currency', currency)
        if (cancelled || id !== requestIdRef.current) return // unmounted or stale
        for (const r of (surchargeRows ?? []) as Array<{
          material_option_id: string
          quantity: number
          surcharge: number
        }>) {
          const entry = surchargesByOptionId.get(r.material_option_id) ?? {}
          entry[r.quantity] = Number(r.surcharge)
          surchargesByOptionId.set(r.material_option_id, entry)
        }
      }

      setData({
        tiersByVariantId: tiersMap,
        options,
        surchargesByOptionId,
        loading: false,
        loadedCurrency: currency,
        loadedMaterialId: materialId,
      })
    })

    return () => { cancelled = true }
  }, [materialId, currency])

  return data
}
