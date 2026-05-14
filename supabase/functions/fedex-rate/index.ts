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
  let weightGrams: number | undefined
  let currency: 'GBP' | 'EUR' | 'USD' | undefined
  try {
    const body = await req.json()
    destCountry  = typeof body?.destCountry === 'string'  ? body.destCountry.trim().toUpperCase()  : undefined
    destPostcode = typeof body?.destPostcode === 'string' ? body.destPostcode.trim().toUpperCase() : undefined
    weightGrams  = typeof body?.weightGrams === 'number'  ? Math.round(body.weightGrams) : undefined
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
  if (!weightGrams || weightGrams <= 0) {
    return json({ error: 'weightGrams must be a positive integer' }, 400)
  }
  if (!currency) {
    return json({ error: 'currency must be one of GBP, EUR, USD' }, 400)
  }

  // ── Read FedEx secrets ─────────────────────────────────────────
  const apiKey = Deno.env.get('FEDEX_API_KEY')
  const apiSecret = Deno.env.get('FEDEX_API_SECRET')
  const accountNumber = Deno.env.get('FEDEX_ACCOUNT_NUMBER')
  if (!apiKey || !apiSecret || !accountNumber) {
    return json({ error: 'FedEx credentials not configured' }, 500)
  }

  // ── Cache lookup ───────────────────────────────────────────────
  const cacheCutoffIso = new Date(Date.now() - CACHE_TTL_MS).toISOString()
  const { data: cachedRow } = await admin
    .from('fedex_rate_cache')
    .select('response, fetched_at')
    .eq('dest_country', destCountry)
    .eq('dest_postcode', destPostcode)
    .eq('weight_grams', weightGrams)
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

  // ── Live FedEx call ────────────────────────────────────────────
  try {
    const token = await getFedExToken(apiKey, apiSecret)
    const raw = await requestRate(token, {
      destCountry,
      destPostcode,
      weightKg: weightGrams / 1000,
      currency,
      accountNumber,
    })
    const parsed = parseRateResponse(raw, currency)
    const nowIso = new Date().toISOString()

    // Persist to the cache. Upsert on the unique-index columns so a
    // re-fetch of the same lane (rare; would mean two designers hit
    // an expired row at the same time) updates rather than dupes.
    // Fire-and-forget — we don't await the result for the response.
    void admin
      .from('fedex_rate_cache')
      .upsert(
        {
          dest_country: destCountry,
          dest_postcode: destPostcode,
          weight_grams: weightGrams,
          currency,
          response: parsed as unknown as Record<string, unknown>,
          fetched_at: nowIso,
        },
        { onConflict: 'dest_country,dest_postcode,weight_grams,currency' },
      )
      .then(({ error }) => {
        if (error) console.error('fedex_rate_cache upsert failed:', error.message)
      })

    const payload: CachedResponse = {
      ...parsed,
      cached: false,
      quotedAt: nowIso,
    }
    return json(payload)
  } catch (err) {
    if (err instanceof FedExError) {
      console.error('fedex-rate FedExError:', err.status, err.message)
      return json({ error: err.message }, 502)
    }
    console.error('fedex-rate error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
