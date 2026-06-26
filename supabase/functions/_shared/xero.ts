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
// customer), accounting.invoices (create the invoice), accounting.payments
// (record the payment so the invoice marks Paid — without this, PUT /Payments
// returns 401 AuthorizationUnsuccessful while invoice creation still works),
// offline_access (refresh token), openid (the connection/identity).
// NOTE: adding/removing a scope requires the admin to RECONNECT Xero so the
// new consent + token carry it; a token refresh keeps the original grant.
export const XERO_SCOPES =
  'openid accounting.contacts accounting.invoices accounting.payments offline_access'

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
  // When set, bind the invoice to this EXISTING Xero contact by ContactID so it
  // files under the customer's existing record (with all their invoice history)
  // rather than spawning a fresh contact from the payer. Xero IGNORES the Name /
  // EmailAddress / Addresses fields whenever a ContactID is supplied, so those
  // are used only on the new-customer fallback where this is null.
  contactId?: string | null
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
    // Bind to an existing Xero contact by ContactID when the designer chose one
    // (so the invoice files under the customer's existing record); otherwise
    // build the contact from the payer — the legacy match-or-create path Xero
    // resolves by Name. Xero ignores Name/Email/Addresses when a ContactID is
    // present, so the company contact's own details are never overwritten.
    Contact: p.contactId
      ? { ContactID: p.contactId }
      : {
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

// Apply a payment to an invoice, paying it into the given account (the Stripe
// clearing/bank account). Marks the invoice PAID immediately. Best-effort:
// returns ok=false + the Xero error text on failure so the caller can log it
// without failing the webhook. Must target the Stripe CLEARING account so the
// later Stripe feed reconciles against this payment instead of double-counting.
export async function recordInvoicePayment(
  accessToken: string,
  tenantId: string,
  p: { invoiceId: string; accountCode: string; amount: number; date?: string },
): Promise<{ ok: boolean; error: string | null }> {
  const body = {
    Invoice: { InvoiceID: p.invoiceId },
    Account: { Code: p.accountCode },
    Amount: p.amount,
    Date: p.date ?? new Date().toISOString().slice(0, 10),
  }
  const res = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
    method: 'PUT',
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
    return { ok: false, error: `${res.status} ${text}` }
  }
  return { ok: true, error: null }
}

// Email an already-created invoice to its contact, using the organisation's
// default branding-theme invoice email (Xero composes + sends it — we don't
// supply a body). This is what delivers the customer's VAT receipt to their
// inbox. Xero requires the invoice to be ACCREC and SUBMITTED/AUTHORISED
// (createSalesInvoice defaults to AUTHORISED) and the contact to carry an
// email address (set from the Stripe payer at create). Because the webhook
// records the clearing-account payment before this call, the emailed invoice
// reads as PAID. POST /Invoices/{id}/Email takes an empty body and responds
// 204 No Content on success. Best-effort: the caller logs the error and never
// fails the webhook over it. Returns ok=false with Xero's text on any non-2xx.
export async function emailSalesInvoice(
  accessToken: string,
  tenantId: string,
  invoiceId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}/Email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
  })
  if (res.ok) return { ok: true, error: null } // 204 No Content on success
  const text = await res.text().catch(() => '<body read failed>')
  console.error('[xero] invoice email failed:', res.status, text)
  return { ok: false, error: `${res.status} ${text}` }
}

// List the org's BANK accounts (name + code), for the admin Stripe-clearing-
// account picker. Returns [] on any failure (the picker just shows empty).
export async function listBankAccounts(
  accessToken: string,
  tenantId: string,
): Promise<{ name: string; code: string }[]> {
  const res = await fetch(
    `https://api.xero.com/api.xro/2.0/Accounts?where=${encodeURIComponent('Type=="BANK"')}`,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' } },
  )
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  return ((data?.Accounts as Array<{ Name?: string; Code?: string }> | undefined) ?? [])
    .map((a) => ({ name: a.Name ?? '', code: a.Code ?? '' }))
    .filter((a) => a.code)
}

// Search the org's contacts for the Create-order Xero-customer picker. Uses
// Xero's `searchTerm` query param — a case-insensitive match across Name,
// FirstName, LastName, ContactNumber, CompanyNumber and EmailAddress — so the
// designer can find a customer by company name OR a person's email. Returns a
// light id+name+email list capped at `limit` so the picker stays snappy; []
// on any failure (the picker just shows "no matches"). Archived contacts are
// excluded (Xero omits them unless includeArchived=true).
export async function searchContacts(
  accessToken: string,
  tenantId: string,
  term: string,
  limit = 25,
): Promise<{ id: string; name: string; email: string | null }[]> {
  const res = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?searchTerm=${encodeURIComponent(term)}&page=1`,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' } },
  )
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  return ((data?.Contacts as Array<{ ContactID?: string; Name?: string; EmailAddress?: string }> | undefined) ?? [])
    .filter((c) => c.ContactID && c.Name)
    .slice(0, limit)
    .map((c) => ({ id: c.ContactID as string, name: c.Name as string, email: c.EmailAddress || null }))
}

// Keep the VAT-invoice email reaching the person who PAID even when the invoice
// is filed under a different (company) Xero contact. Xero emails an invoice to
// the bound contact's primary email PLUS any ContactPerson flagged
// IncludeInEmails — so when the payer's email is neither the contact's primary
// nor an already-included person, add them as an included contact person
// (preserving the existing primary email and any other persons). Idempotent:
// returns added=false when the payer is already a recipient, so a Stripe retry
// never duplicates the person. Best-effort: returns ok=false + Xero's text on
// failure so the caller logs it without failing the webhook. Requires the
// accounting.contacts WRITE scope (already in XERO_SCOPES).
export async function ensureInvoiceEmailRecipient(
  accessToken: string,
  tenantId: string,
  contactId: string,
  email: string,
  name?: string | null,
): Promise<{ ok: boolean; added: boolean; error: string | null }> {
  const target = email.trim().normalize('NFC').toLowerCase()
  if (!target) return { ok: true, added: false, error: null }

  // Read the contact's current primary email + persons so we never clobber them.
  const getRes = await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' },
  })
  if (!getRes.ok) {
    const text = await getRes.text().catch(() => '<body read failed>')
    return { ok: false, added: false, error: `${getRes.status} ${text}` }
  }
  const data = await getRes.json().catch(() => null)
  const contact = (data?.Contacts?.[0] as Record<string, unknown> | undefined) ?? null
  if (!contact) return { ok: false, added: false, error: 'contact not found' }

  const primary = String(contact.EmailAddress ?? '').trim().normalize('NFC').toLowerCase()
  if (primary === target) return { ok: true, added: false, error: null } // already the primary recipient

  // Preserve every existing person verbatim (we spread the raw objects, so any
  // Xero-side fields survive) — Xero replaces the ContactPersons array with what
  // we send, while omitted top-level fields (EmailAddress, Name, Addresses) are
  // left unchanged (verified Xero merge semantics).
  const persons = (contact.ContactPersons as Array<Record<string, unknown>> | undefined) ?? []
  const already = persons.some(
    (p) => String(p.EmailAddress ?? '').trim().normalize('NFC').toLowerCase() === target && p.IncludeInEmails === true,
  )
  if (already) return { ok: true, added: false, error: null }

  // Append the payer as an included person, preserving every existing one.
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const first = parts[0] || 'Customer'
  const last = parts.slice(1).join(' ')
  const updatedPersons = [
    ...persons,
    { FirstName: first, ...(last ? { LastName: last } : {}), EmailAddress: email.trim(), IncludeInEmails: true },
  ]
  const postRes = await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${contactId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ ContactID: contactId, ContactPersons: updatedPersons }),
  })
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => '<body read failed>')
    return { ok: false, added: false, error: `${postRes.status} ${text}` }
  }
  return { ok: true, added: true, error: null }
}
