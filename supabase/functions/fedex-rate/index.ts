// Designer-only FedEx rate lookup for the Quote compiler.
//
// POST body: { destCountry, destPostcode, weightGrams, currency }
// Response:  ParsedRate plus a `cached: boolean` flag — see
//            _shared/fedex.ts for the full ParsedRate shape.
//
// Designer or admin role required (requireDesigner from _shared/admin.ts).
// Requires FEDEX_API_KEY, FEDEX_API_SECRET, FEDEX_ACCOUNT_NUMBER
// secrets. Reads/writes the fedex_rate_cache table via service-role
// (frontend has no access — RLS enabled with no policies, grants
// REVOKEd per migration 000178).
//
// Cache discipline:
//   * Key on (destCountry, destPostcode, weightGrams, currency) — the
//     exact four inputs that determine a rate. Unique index on those
//     four columns in migration 000178 makes the upsert keyed
//     directly off it.
//   * TTL is 12 hours, enforced here in code rather than in SQL. Most
//     compiler-driven lookups will repeat lanes within the same
//     working day; a 12h window keeps the cache fresh enough that
//     designers see the current fuel surcharge without flooding
//     FedEx on every keystroke.
//   * The international % adjustment (settings.fedex_intl_adjust_percent)
//     is applied frontend-side at render time, NOT cached here, so
//     admin changes take effect immediately without invalidating the
//     cache.

import { requireDesigner, CORS_HEADERS, json } from '../_shared/admin.ts'
import {
  getFedExToken,
  requestRate,
  parseRateResponse,
  FedExError,
  type ParsedRate,
} from '../_shared/fedex.ts'

const CACHE_TTL_MS = 12 * 60 * 60 * 1000

interface CachedResponse extends ParsedRate {
  cached: boolean
  quotedAt: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Designer or admin role required. Customers and any other non-
  // staff role have no business hitting this endpoint — shipping is
  // a designer-only readout.
  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin } = check

  // ── Validate body ──────────────────────────────────────────────
  let destCountry: string | undefined
  let destPostcode: string | undefined
  let boxWeightsGrams: number[] | undefined
  let currency: 'GBP' | 'EUR' | 'USD' | undefined
  try {
    const body = await req.json()
    destCountry  = typeof body?.destCountry === 'string'  ? body.destCountry.trim().toUpperCase()  : undefined
    destPostcode = typeof body?.destPostcode === 'string' ? body.destPostcode.trim().toUpperCase() : undefined
    // Accept either the new boxWeightsGrams array or the legacy
    // single-value weightGrams (for backwards compat with any
    // unrefreshed client). The array is canonical going forward.
    if (Array.isArray(body?.boxWeightsGrams)) {
      const list = body.boxWeightsGrams
        .map((w: unknown) => (typeof w === 'number' ? Math.round(w) : NaN))
        .filter((w: number) => Number.isFinite(w) && w > 0)
      if (list.length > 0) boxWeightsGrams = list
    } else if (typeof body?.weightGrams === 'number' && body.weightGrams > 0) {
      boxWeightsGrams = [Math.round(body.weightGrams)]
    }
    const c = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : null
    if (c === 'GBP' || c === 'EUR' || c === 'USD') currency = c
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!destCountry || destCountry.length !== 2) {
    return json({ error: 'destCountry must be a 2-letter ISO country code' }, 400)
  }
  if (!destPostcode) {
    return json({ error: 'destPostcode is required' }, 400)
  }
  if (!boxWeightsGrams || boxWeightsGrams.length === 0) {
    return json({ error: 'boxWeightsGrams must be a non-empty array of positive integers' }, 400)
  }
  if (!currency) {
    return json({ error: 'currency must be one of GBP, EUR, USD' }, 400)
  }
  const totalWeightGrams = boxWeightsGrams.reduce((a, b) => a + b, 0)
  const isSingleBox = boxWeightsGrams.length === 1

  // ── Read FedEx secrets ─────────────────────────────────────────
  const apiKey = Deno.env.get('FEDEX_API_KEY')
  const apiSecret = Deno.env.get('FEDEX_API_SECRET')
  const accountNumber = Deno.env.get('FEDEX_ACCOUNT_NUMBER')
  if (!apiKey || !apiSecret || !accountNumber) {
    return json({ error: 'FedEx credentials not configured' }, 500)
  }

  // ── Cache lookup ───────────────────────────────────────────────
  // Cache is keyed on the four columns we always had: country,
  // postcode, weight, currency. Multi-box shipments would need
  // extra key dimensions (box count and per-box weights) to be
  // cached safely, which would require a schema change. For now
  // we skip the cache entirely on multi-box requests — they're
  // less common than single-box and the round-trip to FedEx is
  // sub-second, so cache miss latency is acceptable.
  const cacheCutoffIso = new Date(Date.now() - CACHE_TTL_MS).toISOString()
  if (isSingleBox) {
    const { data: cachedRow } = await admin
      .from('fedex_rate_cache')
      .select('response, fetched_at')
      .eq('dest_country', destCountry)
      .eq('dest_postcode', destPostcode)
      .eq('weight_grams', totalWeightGrams)
      .eq('currency', currency)
      .gte('fetched_at', cacheCutoffIso)
      .maybeSingle()

    if (cachedRow?.response) {
      const parsed = cachedRow.response as ParsedRate
      const payload: CachedResponse = {
        ...parsed,
        cached: true,
        quotedAt: cachedRow.fetched_at as string,
      }
      return json(payload)
    }
  }

  // ── Live FedEx call ────────────────────────────────────────────
  try {
    const token = await getFedExToken(apiKey, apiSecret)
    const raw = await requestRate(token, {
      destCountry,
      destPostcode,
      boxWeightsKg: boxWeightsGrams.map((g) => g / 1000),
      currency,
      accountNumber,
    })
    const parsed = parseRateResponse(raw, currency)
    const nowIso = new Date().toISOString()

    // Persist to the cache. Skip for multi-box (see note at the
    // cache-lookup branch above). Upsert on the unique-index columns
    // so a re-fetch of the same lane (rare — would mean two
    // designers hit an expired row at the same time) updates rather
    // than dupes. Fire-and-forget — we don't await the result.
    if (isSingleBox) {
      void admin
        .from('fedex_rate_cache')
        .upsert(
          {
            dest_country: destCountry,
            dest_postcode: destPostcode,
            weight_grams: totalWeightGrams,
            currency,
            response: parsed as unknown as Record<string, unknown>,
            fetched_at: nowIso,
          },
          { onConflict: 'dest_country,dest_postcode,weight_grams,currency' },
        )
        .then(({ error }) => {
          if (error) console.error('fedex_rate_cache upsert failed:', error.message)
        })
    }

    const payload: CachedResponse = {
      ...parsed,
      cached: false,
      quotedAt: nowIso,
    }
    return json(payload)
  } catch (err) {
    if (err instanceof FedExError) {
      console.error('fedex-rate FedExError:', err.status, err.message)
      // FedExError carries the upstream FedEx body verbatim in its
      // message (see _shared/fedex.ts). Extract just the FedEx-side
      // human-readable bit so the frontend doesn't have to parse a
      // wrapped JSON string out of a wrapped JSON string.
      const friendly = extractFedExErrorMessage(err.message) ?? err.message
      return json({
        error: friendly,
        fedex_status: err.status,
      }, 502)
    }
    console.error('fedex-rate error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})

// FedExError.message looks like:
//   `FedEx rate error (400): {"transactionId":"...","errors":[{"code":"...","message":"..."}]}`
// Pull the embedded JSON out and return the first errors[].message
// so the frontend can map it to a friendly hint (or surface it as-is).
function extractFedExErrorMessage(raw: string): string | null {
  const colonIdx = raw.indexOf(':')
  if (colonIdx < 0) return null
  const bodyStr = raw.slice(colonIdx + 1).trim()
  try {
    const body = JSON.parse(bodyStr)
    const first = body?.errors?.[0]
    if (first && typeof first.message === 'string') return first.message
  } catch {
    // Body wasn't JSON — fall through.
  }
  return null
}
