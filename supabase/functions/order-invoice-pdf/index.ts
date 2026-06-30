// order-invoice-pdf — stream a paid order's Xero invoice back as a PDF, for the
// "Download invoice" button on the Orders page To-order card.
//
// Xero has no public PDF URL: the "Invoiced ↗" pill links to the Xero web app
// (a logged-in view) and the customer-facing OnlineInvoiceUrl (order-vat-invoice)
// is an HTML page. The only way to a PDF is the API with `Accept: application/pdf`
// on GET /Invoices/{id}, which needs the org's OAuth token — so it must run in an
// edge function holding the service-role Xero connection, not a client fetch.
//
// Returns the PDF bytes with `Content-Disposition: attachment` so the browser
// download helper (downloadBlob) saves it named after the order's reference; on
// any problem returns a JSON error the frontend surfaces inline (the card only
// shows the button once an invoice exists, so these are edge cases).
//
// Auth: in-body designer/admin check on the caller's JWT (mirrors _shared
// requireDesigner). Deployed verify_jwt=FALSE — like the other browser-GET
// download functions (export-orders / export-audit-log / retry-order-invoice) —
// because a GET's CORS preflight OPTIONS carries no JWT and platform-level
// verify_jwt would reject it before this handler runs. The in-body check is the
// real gate.
//
// Self-contained on purpose: the slim auth + Xero-token helpers are inlined
// (rather than importing ../_shared/admin.ts + ../_shared/xero.ts) so this single
// file is the entire function. That keeps the deployed bytes byte-identical to
// this repo source, since the function is deployed on its own via the MCP tool,
// which can't bundle the relative _shared imports. The canonical, shared versions
// of this logic live in _shared/admin.ts (requireDesigner) and _shared/xero.ts
// (getAccessContext) — keep behaviour in step if either changes.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  // Let the browser read the filename so the download helper names the file.
  'Access-Control-Expose-Headers': 'Content-Disposition',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Keep the reference safe to drop into a Content-Disposition filename: strip
// anything outside a conservative set so a quote/newline can't break the header.
function safeRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'invoice'
}

const TOKEN_URL = 'https://identity.xero.com/connect/token'
const CONNECTIONS_URL = 'https://api.xero.com/connections'

function basicAuth(): string {
  const id = Deno.env.get('XERO_CLIENT_ID') ?? ''
  const secret = Deno.env.get('XERO_CLIENT_SECRET') ?? ''
  return 'Basic ' + btoa(`${id}:${secret}`)
}

// Slim copy of _shared/xero.ts getAccessContext: return a valid access token +
// tenant id, refreshing (and rotating the stored refresh token) when the cached
// token is missing or within 60s of expiry. Returns null when Xero isn't
// connected. Behaviour MUST match the shared helper (rotating-token writeback).
async function getAccessContext(
  admin: ReturnType<typeof createClient>,
): Promise<{ accessToken: string; tenantId: string } | null> {
  const { data: conn } = await admin.from('xero_connection').select('*').eq('id', 1).single()
  if (!conn?.refresh_token) return null

  const stillValid =
    conn.access_token &&
    conn.access_token_expires_at &&
    new Date(conn.access_token_expires_at).getTime() - 60_000 > Date.now()
  if (stillValid && conn.tenant_id) {
    return { accessToken: conn.access_token as string, tenantId: conn.tenant_id as string }
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token as string }).toString(),
  })
  if (!res.ok) throw new Error(`Xero token refresh failed: ${res.status} ${await res.text()}`)
  const tok = await res.json() as { access_token: string; refresh_token: string; expires_in: number }

  let tenantId = (conn.tenant_id as string | null) ?? null
  if (!tenantId) {
    const cRes = await fetch(CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
    })
    if (cRes.ok) {
      const arr = await cRes.json()
      tenantId = Array.isArray(arr) && arr.length > 0 ? (arr[0].tenantId as string) : null
    }
  }

  await admin
    .from('xero_connection')
    .update({
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 1800) * 1000).toISOString(),
      tenant_id: tenantId,
      pending_state: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)

  if (!tenantId) return null
  return { accessToken: tok.access_token, tenantId }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  // In-body designer/admin auth (mirrors _shared requireDesigner).
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()

  const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: profile } = await admin
    .from('profiles')
    .select('role, deactivated_at')
    .eq('id', userData.user.id)
    .single()
  if (!profile || profile.deactivated_at) return json({ error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ error: 'Forbidden' }, 403)

  const orderId = new URL(req.url).searchParams.get('order_id')
  if (!orderId) return json({ error: 'Missing order_id' }, 400)

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, xero_invoice_id, payment_reference')
    .eq('id', orderId)
    .single<{ id: string; xero_invoice_id: string | null; payment_reference: string | null }>()
  if (orderErr || !order) return json({ error: 'Order not found' }, 404)
  if (!order.xero_invoice_id) return json({ error: 'This order has no Xero invoice yet.' }, 409)

  let ctx: { accessToken: string; tenantId: string } | null
  try {
    ctx = await getAccessContext(admin)
  } catch (e) {
    console.error('[order-invoice-pdf] Xero token error:', (e as Error).message)
    return json({ error: 'Xero connection problem — reconnect Xero in Settings.' }, 502)
  }
  if (!ctx) return json({ error: 'Xero is not connected — reconnect Xero in Settings.' }, 502)

  const xeroRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${order.xero_invoice_id}`, {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Xero-tenant-id': ctx.tenantId,
      Accept: 'application/pdf',
    },
  })
  if (!xeroRes.ok) {
    const text = await xeroRes.text().catch(() => '<body read failed>')
    console.error('[order-invoice-pdf] Xero PDF fetch failed:', xeroRes.status, text)
    return json({ error: 'Could not fetch the invoice PDF from Xero.' }, 502)
  }

  const pdf = await xeroRes.arrayBuffer()
  const filename = `Invoice ${safeRef(order.payment_reference ?? order.id)}.pdf`
  return new Response(pdf, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdf.byteLength),
    },
  })
})
