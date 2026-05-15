// Anon-safe fetch of public_get_price_list. Uses the same Supabase
// URL + anon key that ship in the SPA bundle today — these are
// public-safe values (anon JWT) and the migration's RLS posture
// assumes anon callers.
//
// Implemented with fetch() rather than @supabase/supabase-js to
// keep the bundled script small for the Squarespace embed. The RPC
// endpoint matches the dashboard's REST shape.
//
// Failure handling: one fast retry after a short delay, then resolve
// with null so the caller can render the quiet "pricing is being
// updated" state rather than throwing into the page.

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Surfaced at build time, not runtime — the Netlify build will fail
  // if the env vars aren't set, which is the right time to catch this.
  throw new Error(
    'price-list/fetch.ts: VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing at build time.',
  )
}

import type { ApiPayload } from './render'

const ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/public_get_price_list`

async function callOnce(currency: string, signal?: AbortSignal): Promise<ApiPayload | null> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_currency: currency }),
  })
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as ApiPayload | null
  if (!data || !Array.isArray(data.materials)) {
    return null
  }
  return data
}

export interface FetchOptions {
  retries?: number
  retryDelayMs?: number
  signal?: AbortSignal
}

export async function fetchPriceList(
  currency: string,
  options: FetchOptions = {},
): Promise<ApiPayload | null> {
  const retries = options.retries ?? 1
  const retryDelayMs = options.retryDelayMs ?? 1500
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await callOnce(currency, options.signal)
      if (result) return result
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
  return null
}
