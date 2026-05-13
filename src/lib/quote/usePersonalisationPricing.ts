import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import type { Currency, PersonalisationPricing } from '../types'

// Live personalisation rate + min charge fetcher for the quote
// compiler, keyed on currency only (migration 000172). Mirrors the
// fetch-once-per-currency-change discipline of usePricing — three
// rows in personalisation_pricing total, one per currency, so each
// fetch is a single-row lookup.
//
// Returns null while loading and when the currency is null. The
// compiler treats "null pricing" as "personalisation unavailable"
// and hides the surcharge breakdown line; the personalisation
// checkbox stays disabled until the row arrives.
//
// No snapshot: the customer page and the compiler both read live so
// an admin rate edit propagates everywhere on the next render.

export function usePersonalisationPricing(currency: Currency | null): {
  pricing: PersonalisationPricing | null
  loading: boolean
} {
  const [pricing, setPricing] = useState<PersonalisationPricing | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Clear before the early-return so a currency flip to null
    // wipes stale pricing too. Without this, callers see the
    // previous currency's rate/floor applied to the new currency's
    // quantities for one network round-trip — bug sweep finding
    // (medium severity).
    setPricing(null)
    if (!currency) {
      return
    }
    let cancelled = false
    setLoading(true)
    supabase
      .from('personalisation_pricing')
      .select('per_card_rate, min_charge')
      .eq('currency', currency)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        setLoading(false)
        if (error || !data) {
          setPricing(null)
          return
        }
        setPricing({
          per_card_rate: Number(data.per_card_rate),
          min_charge: Number(data.min_charge),
        })
      })
    return () => { cancelled = true }
  }, [currency])

  return { pricing, loading }
}
