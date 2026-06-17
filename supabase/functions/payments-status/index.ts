// payments-status — admin-only read of where the ordering pipeline is
// currently pointed: Stripe (test vs live, and whether the keys are actually
// present + look right) and Xero (which organisation is connected, and whether
// it's the sandbox Demo Company). Powers the "Payments & accounting status"
// panel on Admin → Settings and the go-live readiness verdict.
//
// It never returns any secret — only derived facts: the selected mode, booleans
// for key presence, and the sk_test_/sk_live_ PREFIX of the selected key (so a
// "mode=live but a test key is in the live slot" misconfiguration is visible).
//
// Auth: admin only (requireAdmin). Read-only; makes one Xero GET /Organisation
// call via the existing connection when Xero is connected.

import { requireAdmin, json, CORS_HEADERS } from '../_shared/admin.ts'
import { getAccessContext, listBankAccounts } from '../_shared/xero.ts'

// Classify a Stripe key by prefix without revealing it. Stripe keys are
// sk_test_… / sk_live_… (and rk_… restricted keys mirror the same infix).
function keyKind(key: string | undefined): 'test' | 'live' | 'unknown' | 'absent' {
  if (!key) return 'absent'
  if (key.includes('_test_')) return 'test'
  if (key.includes('_live_')) return 'live'
  return 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  const ctxOrResp = await requireAdmin(req)
  if (ctxOrResp instanceof Response) return ctxOrResp
  const { admin } = ctxOrResp

  // ── Stripe ───────────────────────────────────────────────────────
  const { data: modeRow } = await admin.from('settings').select('payment_mode, xero_stripe_account_code').eq('id', 1).single()
  const mode = modeRow?.payment_mode === 'live' ? 'live' : 'test'
  const stripeAccountCode = (modeRow?.xero_stripe_account_code as string | null | undefined) ?? null

  const legacyKey = Deno.env.get('STRIPE_SECRET_KEY')
  const testKey = Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? legacyKey
  const liveKey = Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? legacyKey
  const selectedKey = mode === 'live' ? liveKey : testKey
  // What the selected key actually IS — the mismatch we most want to surface is
  // mode=live but the key behind it is a test key (or absent).
  const selectedKeyKind = keyKind(selectedKey)

  const stripe = {
    mode, // the admin-selected mode
    selectedKeyKind, // 'test' | 'live' | 'unknown' | 'absent' — what the selected key really is
    testKeyPresent: !!testKey,
    liveKeyPresent: !!liveKey,
    webhookTestSecretPresent: !!(Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST') ?? Deno.env.get('STRIPE_WEBHOOK_SECRET')),
    webhookLiveSecretPresent: !!(Deno.env.get('STRIPE_WEBHOOK_SECRET_LIVE') ?? Deno.env.get('STRIPE_WEBHOOK_SECRET')),
    // Live mode is only safe when the live key is present AND really a live key.
    consistent: mode === 'test'
      ? (selectedKeyKind === 'test' || selectedKeyKind === 'unknown')
      : selectedKeyKind === 'live',
  }

  // ── Xero ─────────────────────────────────────────────────────────
  // One live GET /Organisation through the existing connection so the panel
  // always shows the truth (no stored copy to drift). Degrades to
  // connected:false on any failure rather than erroring the whole panel.
  let xero: {
    connected: boolean
    orgName: string | null
    isDemoCompany: boolean | null
    baseCurrency: string | null
    error: string | null
  } = { connected: false, orgName: null, isDemoCompany: null, baseCurrency: null, error: null }
  // BANK accounts for the Stripe-clearing-account picker (admin only).
  let bankAccounts: { name: string; code: string }[] = []

  try {
    const acc = await getAccessContext(admin)
    if (!acc) {
      xero = { ...xero, connected: false, error: 'Not connected' }
    } else {
      bankAccounts = await listBankAccounts(acc.accessToken, acc.tenantId)
      const res = await fetch('https://api.xero.com/api.xro/2.0/Organisation', {
        headers: {
          Authorization: `Bearer ${acc.accessToken}`,
          'Xero-tenant-id': acc.tenantId,
          Accept: 'application/json',
        },
      })
      if (!res.ok) {
        xero = { ...xero, connected: true, error: `Xero ${res.status}` }
      } else {
        const data = await res.json().catch(() => null)
        const org = data?.Organisations?.[0] ?? null
        xero = {
          connected: true,
          orgName: (org?.Name as string | undefined) ?? null,
          isDemoCompany: typeof org?.IsDemoCompany === 'boolean' ? org.IsDemoCompany : null,
          baseCurrency: (org?.BaseCurrency as string | undefined) ?? null,
          error: null,
        }
      }
    }
  } catch (e) {
    xero = { ...xero, error: (e as Error).message }
  }

  // ── Combined verdict ─────────────────────────────────────────────
  // The dangerous state is a money/books mismatch: real Stripe payments into a
  // Demo Xero org, or a live Xero org behind test payments. "ready" means both
  // sides are live and consistent; "danger" flags an active mismatch; "test"
  // means everything's still in sandbox (the safe default).
  const stripeLive = stripe.mode === 'live' && stripe.consistent
  const xeroLive = xero.connected && xero.isDemoCompany === false
  let verdict: 'test' | 'ready' | 'danger' | 'incomplete'
  if (stripe.mode === 'test' && (!xero.connected || xero.isDemoCompany !== false)) {
    verdict = 'test' // fully sandbox — safe
  } else if (stripeLive && xeroLive) {
    verdict = 'ready' // fully live + consistent
  } else if ((stripe.mode === 'live') !== xeroLive || !stripe.consistent) {
    verdict = 'danger' // one side live, the other not — or a bad key behind the mode
  } else {
    verdict = 'incomplete'
  }

  return json({ stripe, xero, verdict, bankAccounts, stripeAccountCode })
})
