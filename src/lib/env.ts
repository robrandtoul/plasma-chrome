// Runtime env access for the proof viewer. Throws clearly if a required
// variable is missing rather than silently rendering a broken surface.

function required(name: string): string {
  const value = import.meta.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing required Vite env var: ${name}. Set it in the Netlify site settings (and .env for local dev).`,
    )
  }
  return value
}

export const SUPABASE_URL = required('VITE_SUPABASE_URL')
export const SUPABASE_ANON_KEY = required('VITE_SUPABASE_ANON_KEY')

// VAPID public key for web-push (notifications). OPTIONAL on purpose: the push
// feature feature-detects and stays hidden until this is set in the Netlify env
// (and .env for local dev), so a deploy without it simply shows no "Enable
// notifications" control rather than throwing. Safe to ship in the bundle — the
// public key is meant to be public; only the private half is a server secret.
export const VAPID_PUBLIC_KEY: string | undefined =
  typeof import.meta.env.VITE_VAPID_PUBLIC_KEY === 'string' &&
  import.meta.env.VITE_VAPID_PUBLIC_KEY.length > 0
    ? import.meta.env.VITE_VAPID_PUBLIC_KEY
    : undefined

// --- Cross-app session, added for the Supabase consolidation ---
//
// Proofs now lives in the `proofs` schema of the shared stock project,
// alongside stock (public) and the vCard app (qr). On a *.plasmadesign.co.uk
// host the proof viewer shares its session cookie with the other staff apps
// via the parent domain, giving staff one login across them.
//
// The proof viewer is staff-only, so unlike the vCard app there is no
// customer host: the only hosts that should NOT receive the parent-domain
// cookie are local dev and Netlify preview deploys, where the cookie stays
// host-only (STAFF_COOKIE_DOMAIN is null).
function staffCookieDomain(): string | null {
  if (typeof window === 'undefined') return null
  const host = window.location.hostname
  return host === 'plasmadesign.co.uk' || host.endsWith('.plasmadesign.co.uk')
    ? '.plasmadesign.co.uk'
    : null
}
export const STAFF_COOKIE_DOMAIN = staffCookieDomain()
