// xero-oauth-start — admin-only. Begins the one-time Xero OAuth
// authorisation: generates a CSRF state, stores it, and returns the Xero
// consent URL for the admin to open. After they consent, Xero redirects
// to xero-oauth-callback, which exchanges the code and stores the tokens.
// Step 5b of the Ordering & checkout build.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { buildAuthorizeUrl } from '../_shared/xero.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin } = check

  if (!Deno.env.get('XERO_CLIENT_ID') || !Deno.env.get('XERO_CLIENT_SECRET')) {
    return json({ error: 'Xero isn’t configured yet — set XERO_CLIENT_ID and XERO_CLIENT_SECRET.' }, 503)
  }

  const state = crypto.randomUUID()
  await admin
    .from('xero_connection')
    .update({ pending_state: state, updated_at: new Date().toISOString() })
    .eq('id', 1)

  return json({ url: buildAuthorizeUrl(state) })
})
