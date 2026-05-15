// Build-time configuration for the contact form. Same anon-safe-env
// pattern as src/price-list/fetch.ts: every value here is baked into
// the IIFE bundle and the build fails loudly at Netlify time if any
// piece is missing.
//
// VITE_TURNSTILE_SITE_KEY is the *public* Cloudflare Turnstile site
// key — safe to ship. The *secret* key lives in Supabase secrets,
// is never bundled, and is only read by the contact-form-submit
// edge function.

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL
const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY

if (!SUPABASE_URL) {
  throw new Error('contact-form/config.ts: VITE_SUPABASE_URL missing at build time.')
}
if (!TURNSTILE_SITE_KEY) {
  throw new Error('contact-form/config.ts: VITE_TURNSTILE_SITE_KEY missing at build time.')
}

export const SUBMIT_ENDPOINT = `${SUPABASE_URL}/functions/v1/contact-form-submit`
export const TURNSTILE_SITE_KEY_PUBLIC = TURNSTILE_SITE_KEY
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

// Mirror of the edge function's caps so the UI rejects oversize /
// disallowed files before the upload starts. Keep in sync with
// supabase/functions/contact-form-submit/index.ts.
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const ALLOWED_MIME_PREFIXES = ['image/']
export const ALLOWED_MIME_EXACT = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
])

export function isAllowedMime(mime: string): boolean {
  const m = (mime || '').toLowerCase()
  if (ALLOWED_MIME_EXACT.has(m)) return true
  return ALLOWED_MIME_PREFIXES.some((p) => m.startsWith(p))
}
