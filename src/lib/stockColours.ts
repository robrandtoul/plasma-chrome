// Stock colours for plastic / acrylic cards.
//
// Proof-viewer models satin, tinted and acrylic as a single generic material
// (e.g. "Satin Plastic"), because the card colour doesn't affect price and the
// designer doesn't pick it at proof time. Stock Control, though, stocks each
// colour as its own row in public.materials (Satin Black / Satin White / Satin
// Navy …) and must allocate the right one — so when a paid order is compiled we
// capture the specific colour and source the list LIVE from Stock Control's own
// catalogue. Storing the verbatim Stock Control name means the in-house hand-off
// parser resolves it first time: no second list to drift, no bounce-back.
//
// We filter by NAME (ilike) rather than embedding public.categories, so this
// needs only the public.materials SELECT grant the authenticated role already
// has (the same cross-schema pattern OrdersPage uses for outsourced_suppliers).

import { supabase } from './supabase'

// Proof-viewer material code → the Stock Control name fragment that scopes the
// colour list to that family. A code that's absent has no colour picker: its
// stock is unambiguous (translucent is one colour), printed (full colour), or
// the colour is carried another way (metal finish / wood species / letterpress).
const STOCK_COLOUR_FILTERS: Record<string, string> = {
  plastic_satin: 'satin',
  plastic_tinted: 'tinted',
  acrylic: 'acrylic',
}

export function materialNeedsStockColour(code: string | null | undefined): boolean {
  return !!code && code in STOCK_COLOUR_FILTERS
}

export interface StockColour {
  name: string
  swatchHex: string | null
  quantityOnShelf: number | null
  measuredIn: string | null
}

// Read the live colour rows for a material's family from Stock Control's
// catalogue (public schema), excluding discontinued (archived) rows, sorted by
// name. Returns [] for a material with no colour picker, or on any read error —
// the caller still offers a free-typed "Other" colour, so a transient failure
// never blocks placing an order.
export async function fetchStockColours(code: string | null | undefined): Promise<StockColour[]> {
  if (!code) return []
  const fragment = STOCK_COLOUR_FILTERS[code]
  if (!fragment) return []
  const { data, error } = await supabase
    .schema('public')
    .from('materials')
    .select('name, swatch_hex, quantity_on_shelf, measured_in')
    .eq('archived', false)
    .ilike('name', `%${fragment}%`)
    .order('name', { ascending: true })
  if (error || !data) return []
  return (data as { name: string; swatch_hex: string | null; quantity_on_shelf: number | null; measured_in: string | null }[])
    .map((r) => ({
      name: r.name,
      swatchHex: r.swatch_hex,
      quantityOnShelf: r.quantity_on_shelf,
      measuredIn: r.measured_in,
    }))
}
