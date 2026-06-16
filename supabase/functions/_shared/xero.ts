// Xero OAuth + token management (Ordering & checkout, Step 5b).
//
// Xero uses OAuth2 with ROTATING refresh tokens: every refresh returns a
// new refresh token and invalidates the old one, so the latest must be
// persisted immediately. The single connection lives in
// proofs.xero_connection (service-role only). These helpers run inside
// edge functions with a service-role client.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const TOKEN_URL = 'https://identity.xero.com/connect/token'
const CONNECTIONS_URL = 'https://api.xero.com/connections'

// Xero's NEW granular scopes (apps created after 2 March 2026 only get
// these — the old broad `accounting.transactions` is gone, which was the
// invalid_scope cause). We need: accounting.contacts (find/create the
// customer), accounting.invoices (create the invoice), offline_access
// (refresh token), openid (the connection/identity).
export const XERO_SCOPES =
  'openid accounting.contacts accounting.invoices offline_access'

function clientId(): string {
  return Deno.env.get('XERO_CLIENT_ID') ?? ''
}

function basicAuth(): string {
  const id = Deno.env.get('XERO_CLIENT_ID') ?? ''
  const secret = Deno.env.get('XERO_CLIENT_SECRET') ?? ''
  return 'Basic ' + btoa(`${id}:${secret}`)
}

// The redirect URI must match exactly what's registered on the Xero app.
// Derived from SUPABASE_URL so it's correct on whichever project this runs.
export function redirectUri(): string {
  return `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/xero-oauth-callback`
}

export function buildAuthorizeUrl(state: string): string {
  // Build the query by hand: the scope list must be space-delimited and
  // encoded as %20. URLSearchParams encodes spaces as '+', which Xero
  // treats literally → "invalid_scope". encodeURIComponent gives %20.
  const q = [
    'response_type=code',
    `client_id=${encodeURIComponent(clientId())}`,
    `redirect_uri=${encodeURIComponent(redirectUri())}`,
    `scope=${encodeURIComponent(XERO_SCOPES)}`,
    `state=${encodeURIComponent(state)}`,
  ].join('&')
  return `${AUTHORIZE_URL}?${q}`
}

interface XeroTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

export async function exchangeCode(code: string): Promise<XeroTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }).toString(),
  })
  if (!res.ok) throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function refreshTokens(refreshToken: string): Promise<XeroTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  })
  if (!res.ok) throw new Error(`Xero token refresh failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

// First tenant (org) the connection has access to. For a single-org
// connection (incl. the Demo Company) there's exactly one.
export async function fetchTenantId(accessToken: string): Promise<string | null> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) return null
  const arr = await res.json()
  return Array.isArray(arr) && arr.length > 0 ? (arr[0].tenantId as string) : null
}

// Persist a freshly-exchanged connection (after the OAuth callback).
export async function storeConnection(
  admin: SupabaseClient,
  tok: XeroTokenResponse,
  tenantId: string | null,
): Promise<void> {
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
}

// Return a valid access token + tenant id, refreshing (and rotating the
// stored refresh token) when the cached access token is missing or within
// 60s of expiry. Returns null when Xero isn't connected yet.
export async function getAccessContext(
  admin: SupabaseClient,
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

  const tok = await refreshTokens(conn.refresh_token as string)
  const tenantId = (conn.tenant_id as string | null) ?? (await fetchTenantId(tok.access_token))
  await storeConnection(admin, tok, tenantId)
  if (!tenantId) return null
  return { accessToken: tok.access_token, tenantId }
}

// One invoice line. `amount` is the authoritative line total in major units
// (it must equal what Stripe charged for this component, so the Stripe→Xero
// bank feed matches on the invoice total). `quantity`, when > 1, shows the real
// card count in the Qty column with a 2dp unit price; because Xero recomputes
// the line from that rounded unit, createSalesInvoice adds a single "Rounding
// adjustment" line for the few-pence difference so the invoice total stays
// exactly equal to `amount`.
// `itemCode` is the Xero ItemCode (e.g. '013', '020', '052'); when set, Xero
// derives the line's sales account (and, for GBP-inclusive, the tax rate) from
// the item — so shipping books to its own account (250) and products to Sales
// (200) automatically. When null we book to the default Sales account
// explicitly (custom-quote / unmapped-variant fallback).
export interface InvoiceLine {
  description: string
  amount: number
  itemCode?: string | null
  quantity?: number | null
}

// A postal address for the Xero contact, so the invoice doesn't read "No
// address". Sourced from the delivery address Stripe collected at checkout
// (falling back to the billing address). All fields optional — we only attach
// an address block when at least a line or postcode is present.
export interface InvoiceAddress {
  line1?: string | null
  line2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
}

export interface InvoiceParams {
  contactName: string
  contactEmail: string | null
  currency: string // GBP | EUR | USD
  reference: string // the order's payment_reference (Stripe<->Xero match key)
  lines: InvoiceLine[]
  address?: InvoiceAddress | null
}

// The result of a create attempt. `invoiceId` is null on any failure (the
// webhook treats that as best-effort and leaves it for retry). `error` carries
// Xero's rejection text on failure (used by the self-test to explain a bad item
// code); `invoice` is the full created invoice object on success — its LineItems
// echo back the ItemCode, TaxType and AccountCode Xero RESOLVED, which is how the
// self-test verifies the product code and tax rate without a second read.
export interface CreateInvoiceResult {
  invoiceId: string | null
  error: string | null
  invoice: Record<string, unknown> | null
}

// Build the Xero invoice object (one entry of the Invoices[] array) from our
// InvoiceParams. Extracted so the Xero self-test can assemble a batch of these
// and POST them in a single call — sharing the exact line assembly (qty/unit
// rounding, ItemCode-vs-AccountCode, EUR/USD NoTax) the live path uses, so the
// test can't pass on logic the real invoice wouldn't run.
export function buildInvoicePayload(
  p: InvoiceParams,
  opts: { status?: 'AUTHORISED' | 'DRAFT' } = {},
): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10)
  const isGbp = p.currency === 'GBP'
  const round2 = (n: number) => Math.round(n * 100) / 100
  // Xero rounds a line's unit price to 2 decimals and computes the line from
  // that, so qty × unit rarely lands on a total built from a round figure
  // (e.g. £509 over 305 cards → £1.67 × 305 = £509.35). We still show the real
  // quantity × unit price, and carry the few-pence difference into a single
  // rounding line so the invoice total matches the Stripe charge to the penny
  // (the bank feed reconciles on that total).
  let roundingAdjustment = 0
  const lineItems = p.lines.map((l) => {
    const li: Record<string, unknown> = { Description: l.description }
    const qty = l.quantity && l.quantity > 1 ? l.quantity : 1
    if (qty > 1) {
      const unit = round2(l.amount / qty)
      li.Quantity = qty
      li.UnitAmount = unit
      roundingAdjustment = round2(roundingAdjustment + (l.amount - round2(qty * unit)))
    } else {
      li.Quantity = 1
      li.UnitAmount = l.amount
    }
    if (l.itemCode) {
      // Item drives the sales account (+ GBP tax rate). Don't set
      // AccountCode — that would override the item's own (e.g. shipping → 250).
      li.ItemCode = l.itemCode
    } else {
      li.AccountCode = Deno.env.get('XERO_SALES_ACCOUNT_CODE') ?? '200'
    }
    // EUR/USD are VAT-free: force NoTax on every line regardless of item.
    if (!isGbp) li.TaxType = 'NONE'
    return li
  })
  if (roundingAdjustment !== 0) {
    // Same tax treatment as the goods lines so VAT stays proportional; books
    // to the Sales account (no ItemCode) so it doesn't distort item revenue.
    const li: Record<string, unknown> = {
      Description: 'Rounding adjustment',
      Quantity: 1,
      UnitAmount: roundingAdjustment,
      AccountCode: Deno.env.get('XERO_SALES_ACCOUNT_CODE') ?? '200',
    }
    if (!isGbp) li.TaxType = 'NONE'
    lineItems.push(li)
  }

  return {
    Type: 'ACCREC',
    Status: opts.status ?? 'AUTHORISED',
    LineAmountTypes: isGbp ? 'Inclusive' : 'NoTax',
    Reference: p.reference,
    Date: today,
    DueDate: today,
    CurrencyCode: p.currency,
    Contact: {
      Name: p.contactName,
      ...(p.contactEmail ? { EmailAddress: p.contactEmail } : {}),
      ...(p.address && (p.address.line1 || p.address.postalCode)
        ? {
            Addresses: [
              {
                AddressType: 'POBOX',
                ...(p.address.line1 ? { AddressLine1: p.address.line1 } : {}),
                ...(p.address.line2 ? { AddressLine2: p.address.line2 } : {}),
                ...(p.address.city ? { City: p.address.city } : {}),
                ...(p.address.region ? { Region: p.address.region } : {}),
                ...(p.address.postalCode ? { PostalCode: p.address.postalCode } : {}),
                ...(p.address.country ? { Country: p.address.country } : {}),
              },
            ],
          }
        : {}),
    },
    LineItems: lineItems,
  }
}

// Create an accounts-receivable invoice in Xero. Defaults to AUTHORISED for the
// live payment path; the self-test passes status 'DRAFT' so its invoices never
// hit the ledger and are trivially deletable. Per Architecture rule #2 we do NOT
// record a payment — the existing Stripe bank feed settles the invoice via the
// shared Reference. GBP is VAT-inclusive (LineAmountTypes Inclusive); EUR/USD are
// VAT-free (NoTax, forced on every line). Lines with an ItemCode let Xero drive
// the sales account + tax rate from the item; lines without one fall back to the
// Sales account (200, override via XERO_SALES_ACCOUNT_CODE). The caller is
// responsible for ensuring the line amounts sum to the charged total.
export async function createSalesInvoice(
  accessToken: string,
  tenantId: string,
  p: InvoiceParams,
  opts: { status?: 'AUTHORISED' | 'DRAFT' } = {},
): Promise<CreateInvoiceResult> {
  const body = { Invoices: [buildInvoicePayload(p, opts)] }

  const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<body read failed>')
    console.error('[xero] invoice create failed:', res.status, text)
    return { invoiceId: null, error: `${res.status} ${text}`, invoice: null }
  }
  const data = await res.json().catch(() => null)
  const invoice = (data?.Invoices?.[0] as Record<string, unknown> | undefined) ?? null
  return {
    invoiceId: (invoice?.InvoiceID as string | undefined) ?? null,
    error: null,
    invoice,
  }
}
