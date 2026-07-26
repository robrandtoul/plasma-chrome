// Grounding data for the draft pipeline: live pricing, lead times and
// prototyping fees fetched via the same SECURITY DEFINER anon RPCs the
// marketing site uses (public_get_price_list, migration 000184;
// public_get_lead_times, 000180; public_get_prototype_prices, 000352).
// Deliberate choice — no service-role key needed locally, and the data is
// exactly what a customer could already see. See docs/ai-draft-pipeline-spec.md.

import { supabaseAnonKey, supabaseUrl } from './env.ts'
import type {
  Currency,
  GroundingData,
  GroundingFigure,
  GroundingMaterial,
  MaterialLeadTime,
  PrototypePrice,
} from './types.ts'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

interface PriceListPayload {
  currency: string
  materials: {
    code: string
    display_name: string
    variants: {
      id: string
      code: string
      display_name: string
      variant_type: string
      ink_count: number | null
      sort_order: number
      tiers: { quantity: number; total_price: number }[]
    }[]
    option_surcharges: { option_code: string; quantity: number; surcharge: number }[]
  }[]
}

// public_get_prototype_prices (000352). "prices" holds only the families that
// are switched on and priced; "not_offered" names the ones we don't prototype.
interface PrototypePricesPayload {
  prices: { family: string; currency: string; amount: number }[]
  not_offered: string[]
}

interface Endpoint {
  url: string
  anonKey: string
}

function endpoint(): Endpoint {
  const url = supabaseUrl()
  const anonKey = supabaseAnonKey()
  if (!url || !anonKey) {
    throw new Error('grounding: Supabase URL / anon key missing from env')
  }
  return { url, anonKey }
}

async function callRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { url, anonKey } = endpoint()
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Proof data lives in the `proofs` schema of the shared stock project —
      // same header convention as src/price-list/fetch.ts.
      'Accept-Profile': 'proofs',
      'Content-Profile': 'proofs',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`grounding: ${name} failed with ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

function toGroundingMaterials(payload: PriceListPayload): GroundingMaterial[] {
  return payload.materials.map((m) => {
    const variants = m.variants.map((v) => ({
      code: v.code,
      display_name: v.display_name,
      variant_type: v.variant_type,
      ink_count: v.ink_count,
      tiers: v.tiers,
    }))
    const quantities = variants.flatMap((v) => v.tiers.map((t) => t.quantity))
    return {
      code: m.code,
      display_name: m.display_name,
      variants,
      option_surcharges: m.option_surcharges,
      minQuantity: quantities.length ? Math.min(...quantities) : null,
    }
  })
}

function collectFigures(byCurrency: Record<Currency, GroundingMaterial[]>): GroundingFigure[] {
  const figures: GroundingFigure[] = []
  for (const currency of CURRENCIES) {
    for (const material of byCurrency[currency]) {
      for (const variant of material.variants) {
        for (const tier of variant.tiers) {
          figures.push({
            amount: tier.total_price,
            currency,
            description: `${material.display_name} ${variant.display_name} x${tier.quantity}`,
            kind: 'tier',
            matKey: material.code,
            quantity: tier.quantity,
          })
        }
      }
      for (const s of material.option_surcharges) {
        figures.push({
          amount: s.surcharge,
          currency,
          description: `${material.display_name} ${s.option_code} surcharge x${s.quantity}`,
          kind: 'addon',
          matKey: material.code,
          quantity: s.quantity,
        })
      }
    }
  }
  return figures
}

// Guard the numbers coming back from the prototype RPC: skip anything that
// isn't one of our three currencies or isn't a real positive amount, so a
// half-configured row can never become a price in front of a customer.
function toPrototypePrices(payload: PrototypePricesPayload | null): PrototypePrice[] {
  return (payload?.prices ?? [])
    .filter((p) => (CURRENCIES as string[]).includes(p.currency))
    .map((p) => ({ family: p.family, currency: p.currency as Currency, amount: Number(p.amount) }))
    .filter((p) => Number.isFinite(p.amount) && p.amount > 0)
}

export async function fetchGrounding(): Promise<GroundingData> {
  const [gbp, eur, usd, leadTimesRaw, prototypesRaw] = await Promise.all([
    callRpc<PriceListPayload>('public_get_price_list', { p_currency: 'GBP' }),
    callRpc<PriceListPayload>('public_get_price_list', { p_currency: 'EUR' }),
    callRpc<PriceListPayload>('public_get_price_list', { p_currency: 'USD' }),
    callRpc<MaterialLeadTime[]>('public_get_lead_times', {}),
    // Prototype prices arrived after the rest of the grounding (migration
    // 000352), so this one failure is swallowed rather than thrown: if the
    // function is deployed before the migration is applied, the RPC 404s and
    // we simply have no prototype data. The prompt then tells the drafter it
    // has none and not to quote one — a missing figure, never a wrong one.
    //
    // Swallowed, but never silent. A permanent failure here (a rolled-back
    // 000352, a lost anon grant) degrades every prototype answer for as long
    // as it lasts, and the drafter cannot tell us — so log it loudly, the way
    // briefing.ts logs its own fallback. Console only: this runs on the anon
    // path with no service-role client to write audit_log with.
    callRpc<PrototypePricesPayload>('public_get_prototype_prices', {}).catch((err) => {
      console.warn(
        '[ai-draft] prototype prices unavailable — drafts will offer to confirm the cost instead of quoting:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }),
  ])
  const byCurrency: Record<Currency, GroundingMaterial[]> = {
    GBP: toGroundingMaterials(gbp),
    EUR: toGroundingMaterials(eur),
    USD: toGroundingMaterials(usd),
  }
  return {
    byCurrency,
    leadTimes: leadTimesRaw ?? [],
    prototypePrices: toPrototypePrices(prototypesRaw),
    prototypeNotOffered: prototypesRaw?.not_offered ?? [],
    figures: collectFigures(byCurrency),
    fetchedAt: new Date().toISOString(),
  }
}

// ── Per-conversation grounding slice ─────────────────────────────────────────
// The drafter's prompt carries only the materials the email plausibly refers
// to (token economy + less room to wander); the guardrail still checks against
// the FULL figure set via guardrails.ts.

const MATERIAL_SYNONYMS: Record<string, string[]> = {
  metal_steel: ['steel', 'stainless', 'silver metal', 'metal card'],
  metal_gold: ['gold'],
  metal_copper: ['copper'],
  metal_gun_metal: ['gun metal', 'gunmetal'],
  metal_matte_black: ['matte black', 'black metal', 'matt black'],
  metal_matte_white: ['matte white', 'white metal', 'matt white'],
  metal_mini_steel: ['mini steel', 'mini card'],
  metal_titanium: ['titanium'],
  carbon_fibre: ['carbon fibre', 'carbon fiber'],
  carbon_fibre_cnc: ['cnc', 'carbon fibre cnc', 'cut carbon'],
  // 'paper' alone is ambiguous between the two paper families — both match,
  // and the briefing tells the drafter to disambiguate from thread cues.
  paper_standard: ['paper', 'standard paper', 'uv spot', 'foil'],
  paper_letterpress: ['paper', 'letterpress', 'colorplan', 'cotton', 'duplex'],
  paper_letterpress_gilded: ['gilding', 'gilded', 'edge gilding'],
  plastic_translucent: ['translucent', 'frosted', 'tinted', 'satin', 'plastic'],
  plastic_full_colour: ['full colour plastic', 'full color plastic', 'pvc'],
  wood: ['wood', 'wooden', 'walnut', 'cherry', 'birch', 'maple', 'bamboo'],
  acrylic: ['acrylic', 'perspex', 'clear card'],
}

// Generic words that legitimately appear in mentions but would match half the
// catalogue through the reverse-containment direction.
const MATCH_STOPLIST = new Set(['card', 'cards', 'business', 'metal'])

export function matchMaterials(mentioned: string[], available: GroundingMaterial[]): string[] {
  const availableCodes = new Set(available.map((m) => m.code))
  // Empty/trivial mentions would otherwise match the whole catalogue via the
  // reverse-containment direction.
  const haystack = mentioned
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length >= 3 && !MATCH_STOPLIST.has(m))
  const matched = new Set<string>()
  for (const m of available) {
    const names = [m.display_name.toLowerCase(), ...(MATERIAL_SYNONYMS[m.code] ?? [])]
    for (const text of haystack) {
      if (names.some((n) => text.includes(n) || (text.length >= 4 && n.includes(text)))) {
        matched.add(m.code)
      }
    }
  }
  // Metal family talk ("metal cards") with no SPECIFIC metal named: include
  // the everyday metals so the drafter can offer the usual starting points.
  // Fires even when a non-metal material also matched ("metal or wood?").
  const metalMatched = [...matched].some((code) => code.startsWith('metal_'))
  const mentionsMetal = mentioned.some((t) => t.toLowerCase().includes('metal'))
  if (!metalMatched && mentionsMetal) {
    for (const code of ['metal_steel', 'metal_gold', 'metal_matte_black']) {
      if (availableCodes.has(code)) matched.add(code)
    }
  }
  return [...matched]
}

export interface GroundingSlice {
  currency: Currency
  // True when the classifier could not infer a currency and GBP was assumed —
  // the draft prompt and the reviewer's note both surface this.
  currencyAssumed: boolean
  materials: GroundingMaterial[]
  leadTimes: MaterialLeadTime[]
  // Prototyping fees for THIS enquiry's currency only. Every family stays in
  // (not just the matched materials): a customer asking for a one-off is often
  // still choosing between materials, and the price difference between wood
  // and metal is the whole point.
  prototypePrices: PrototypePrice[]
  prototypeNotOffered: string[]
  catalogueIndex: { code: string; display_name: string; minQuantity: number | null; startingPrice: number | null }[]
}

export function sliceGrounding(
  grounding: GroundingData,
  mentionedMaterials: string[],
  currencyHint: Currency | 'unknown',
): GroundingSlice {
  const currency: Currency = currencyHint === 'unknown' ? 'GBP' : currencyHint
  const catalogue = grounding.byCurrency[currency]
  const matchedCodes = new Set(matchMaterials(mentionedMaterials, catalogue))
  const materials = catalogue.filter((m) => matchedCodes.has(m.code))
  const catalogueIndex = catalogue.map((m) => {
    const prices = m.variants.flatMap((v) => v.tiers.map((t) => t.total_price))
    return {
      code: m.code,
      display_name: m.display_name,
      minQuantity: m.minQuantity,
      startingPrice: prices.length ? Math.min(...prices) : null,
    }
  })
  return {
    currency,
    currencyAssumed: currencyHint === 'unknown',
    materials,
    leadTimes: grounding.leadTimes,
    // Scoped to the slice currency the same way the materials are — the fee is
    // per (family, currency), so quoting the EUR figure to a UK customer would
    // be the same class of error we are fixing here.
    prototypePrices: grounding.prototypePrices.filter((p) => p.currency === currency),
    prototypeNotOffered: grounding.prototypeNotOffered,
    catalogueIndex,
  }
}
