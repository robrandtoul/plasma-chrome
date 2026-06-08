import { createBrowserClient } from '@supabase/ssr'
import { SUPABASE_ANON_KEY, SUPABASE_URL, STAFF_COOKIE_DOMAIN } from './env'

// After the Supabase consolidation the proof data lives in the `proofs`
// SCHEMA of the shared stock project, so every query and RPC targets
// `proofs`. The names collide with stock's `public` schema under one
// PostgREST, so pinning the schema here is mandatory.
//
// This is the single client used by BOTH the authenticated staff app and
// the anonymous, tokenised customer proof pages (/p/:id). The customer
// pages never sign in; they read via the anon key through SECURITY
// DEFINER RPCs (public_get_customer_proof, record_proof_view) and the
// customer-proof-images edge function. Because they share this client,
// the proofs schema (and the anon path) is covered by the one db option.
//
// The session lives in a cookie, not localStorage: on a *.plasmadesign.co.uk
// staff host it is scoped to .plasmadesign.co.uk so staff get one login
// across the apps (stock, qr, proofs); on local dev and Netlify preview
// deploys it is host-only (STAFF_COOKIE_DOMAIN is null). @supabase/ssr
// chunks the cookie automatically, so sessions over the ~4KB single-cookie
// limit still work.
//
// Bounded auth lock: supabase-js serialises token refresh across tabs with a
// navigator Web Lock named after the storageKey. Because all three plasmadesign
// apps now share one project (one storageKey) under the SSO cookie, they share
// one lock, so a second app/tab holding it can stall getSession() and block
// first paint (the "blank screen, refresh fixes it" hang). Cap the wait and, if
// the lock can't be acquired in time, run the critical section unserialised
// rather than hang the UI. We deliberately keep the shared storageKey (changing
// it would break cross-app SSO); this only bounds how long we wait for the lock.
async function boundedAuthLock<R>(
  name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>,
): Promise<R> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return fn()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  try {
    return await navigator.locks.request(name, { signal: ctrl.signal }, () => fn())
  } catch (err) {
    // AbortError => we couldn't acquire within 2s; proceed without the lock
    // (worst case a rare concurrent token refresh, which supabase-js recovers
    // from) instead of leaving the user on a blank screen.
    if (err instanceof DOMException && err.name === 'AbortError') return fn()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const supabase = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'proofs' },
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
    // Preserved by createBrowserClient (it only overrides flowType /
    // autoRefreshToken / detectSessionInUrl / persistSession / storage).
    lock: boundedAuthLock,
  },
  cookieOptions: {
    sameSite: 'lax',
    secure: typeof window !== 'undefined' && window.location.protocol === 'https:',
    // One year. The session is kept alive by refresh-token rotation; this
    // only bounds how long the cookie itself persists in the browser.
    maxAge: 60 * 60 * 24 * 365,
    ...(STAFF_COOKIE_DOMAIN ? { domain: STAFF_COOKIE_DOMAIN } : {}),
  },
})
