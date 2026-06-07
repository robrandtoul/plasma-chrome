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
export const supabase = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'proofs' },
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
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
