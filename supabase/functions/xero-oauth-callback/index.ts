// xero-oauth-callback — public (Xero redirects the admin's browser here
// after they consent). Verifies the CSRF state, exchanges the auth code
// for tokens, resolves the tenant, and stores the connection. Renders a
// plain HTML confirmation. Step 5b of the Ordering & checkout build.
//
// verify_jwt = false: this is a browser redirect from Xero with no
// Supabase session; the `state` parameter (matched against the stored
// pending_state) is the CSRF protection.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { exchangeCode, fetchTenantId, storeConnection } from '../_shared/xero.ts'

function htmlPage(title: string, message: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
    `<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f6f3;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
    `.card{background:#fff;border:1px solid #e7e5e0;border-radius:14px;padding:32px;max-width:420px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.05)}` +
    `h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#555;margin:0}</style></head>` +
    `<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  if (oauthError) {
    return htmlPage('Xero connection cancelled', `Xero returned: ${oauthError}. You can close this tab and try again.`)
  }
  if (!code || !state) {
    return htmlPage('Xero connection failed', 'The response from Xero was missing required details. Please start again.')
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: conn } = await admin.from('xero_connection').select('pending_state').eq('id', 1).single()
  if (!conn || !conn.pending_state || conn.pending_state !== state) {
    return htmlPage('Xero connection failed', 'Security check failed (state mismatch). Please start the connection again from the admin settings.')
  }

  try {
    const tok = await exchangeCode(code)
    const tenantId = await fetchTenantId(tok.access_token)
    await storeConnection(admin, tok, tenantId)
    if (!tenantId) {
      return htmlPage('Almost there', 'Connected to Xero, but no organisation was found on the connection. Make sure you selected an organisation (e.g. the Demo Company) during consent, then try again.')
    }
    return htmlPage('Xero connected ✓', 'Your Xero organisation is now connected. You can close this tab and return to the app.')
  } catch (e) {
    return htmlPage('Xero connection failed', `We couldn’t complete the connection: ${(e as Error).message}. Please try again.`)
  }
})
