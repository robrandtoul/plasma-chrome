// Admin-only edge function: reports whether the Help Scout OAuth app
// credentials are configured as env vars. Returns nothing sensitive —
// just booleans, so it's safe to expose to the settings page for the
// "Connected" / "Not connected" badge.
//
// A full live-API test is driven separately by the existing
// match-helpscout-conversation function; the settings page just calls
// that with a dummy email to exercise the OAuth + conversations path.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check

  const appId = Deno.env.get('HELPSCOUT_APP_ID') ?? ''
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET') ?? ''

  return json({
    app_id_set: appId.length > 0,
    app_secret_set: appSecret.length > 0,
    connected: appId.length > 0 && appSecret.length > 0,
  })
})
