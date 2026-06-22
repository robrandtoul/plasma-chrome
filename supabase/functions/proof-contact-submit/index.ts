// proof-contact-submit: "Get in touch" form on the customer-facing
// closed-proof screen (CustomerProofPage → AbandonedScreen).
//
// When a proof has been marked abandoned the customer page stops
// showing the proof and renders a quiet "this proof is closed"
// screen. This endpoint backs the contact form on that screen: it
// takes the visitor's message, validates the proof exists, then
// creates a Help Scout conversation in the Customer Support mailbox
// with the proof reference attached — the same destination as the
// marketing-site support form (contact-form-submit), so enquiries
// land in one queue.
//
// Contract:
//   POST /proof-contact-submit
//   body (JSON): {
//     proofId: string   // UUID — the id the customer URL carries
//     email:   string   // the visitor's email (we reply here)
//     name?:   string   // optional display name
//     message: string   // the enquiry body
//     website?: string  // honeypot — must be empty
//   }
//
//   200 { ok: true }   on success (also the silent honeypot drop)
//   400 { error }      missing / malformed input
//   404 { error }      proof not found
//   502 { error }      Help Scout failure (message tells the visitor
//                      to email support@ directly as a fallback)
//   500 { error }      server not configured
//
// Anon-callable (the customer page is unauthenticated). Security
// posture mirrors acknowledge-disclaimer / proof-action: the proof
// URL itself is the access token, and the unguessable proof UUID is
// validated against the DB before anything is created, so the
// endpoint can't be used to spam Help Scout without a real proof id.
// A honeypot field catches dumb bots. (No Cloudflare Turnstile here,
// unlike the public marketing form — that form lives on an indexed
// page with no such gate; this one doesn't.)
//
// Required Supabase secrets (all already configured for this project):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — service-role client
//                                              (reads the proofs schema,
//                                              bypassing RLS).
//   HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET   — Help Scout OAuth creds.
// Optional:
//   HELPSCOUT_SUPPORT_MAILBOX_ID — short-circuits the mailbox lookup.
//   PROOF_VIEWER_BASE_URL        — base for the /p/{id} link in the
//                                  conversation body (defaults to the
//                                  production host).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessToken, HsError } from '../_shared/helpscout.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPPORT_MAILBOX_NAME = 'Customer Support'
const DEFAULT_BASE_URL = 'https://proofs.plasmadesign.co.uk'
const SUPPORT_EMAIL = 'support@plasmadesign.co.uk'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// UUID v4-ish sanity check — the proof id column is a Postgres uuid,
// so anything that doesn't look like one can't match a row.
function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Permissive shape check — Help Scout rejects anything truly malformed
// at the customer-creation step; this just catches obvious typos.
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// Resolve the Customer Support mailbox id once per worker process.
// HELPSCOUT_SUPPORT_MAILBOX_ID short-circuits the lookup. Mirrors the
// resolver in contact-form-submit so both support paths target the
// same mailbox.
let cachedMailboxId: number | null = null
async function resolveMailboxId(token: string): Promise<number> {
  if (cachedMailboxId != null) return cachedMailboxId
  const override = Deno.env.get('HELPSCOUT_SUPPORT_MAILBOX_ID')?.trim()
  if (override) {
    const parsed = parseInt(override, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      cachedMailboxId = parsed
      return parsed
    }
  }
  const resp = await fetch('https://api.helpscout.net/v2/mailboxes', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new HsError(resp.status, `Help Scout mailboxes (${resp.status}): ${text}`)
  }
  const data = (await resp.json().catch(() => null)) as
    | { _embedded?: { mailboxes?: Array<{ id: number; name?: string }> } }
    | null
  const boxes = data?._embedded?.mailboxes ?? []
  const match = boxes.find(
    (b) => (b.name ?? '').trim().toLowerCase() === SUPPORT_MAILBOX_NAME.toLowerCase(),
  )
  if (!match) {
    throw new HsError(500, `Help Scout mailbox "${SUPPORT_MAILBOX_NAME}" not found`)
  }
  cachedMailboxId = match.id
  return match.id
}

// Split a free-text display name into first / last for the Help Scout
// customer record. Help Scout keys the customer by email, so this is
// cosmetic — best-effort is fine.
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

// Build the conversation body: the visitor's message, then a metadata
// block so whoever picks it up sees which proof this is about without
// hunting. Optional values are skipped rather than printed blank.
function buildBody(input: {
  message: string
  email: string
  name: string
  proofId: string
  proofStatus: string
  proofUrl: string
  ownerName: string | null
  ownerCompany: string | null
  linkedConversationUrl: string | null
}): string {
  const lines: string[] = []
  lines.push(input.message.trim())
  lines.push('')
  lines.push('---')
  if (input.name) lines.push(`From: ${input.name}`)
  lines.push(`Email: ${input.email}`)
  lines.push(`Proof: ${input.proofUrl}`)
  lines.push(`Proof status: ${input.proofStatus}`)
  if (input.ownerCompany) lines.push(`Proof company: ${input.ownerCompany}`)
  if (input.ownerName) lines.push(`Proof contact: ${input.ownerName}`)
  if (input.linkedConversationUrl) {
    lines.push(`Original conversation: ${input.linkedConversationUrl}`)
  }
  lines.push('')
  lines.push('Submitted via the closed-proof page in the proof viewer.')
  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // Honeypot — a filled "website" field means a bot. Silent 200 so it
  // can't tell its submission was dropped and won't retry cleaned up.
  const honeypot = typeof body.website === 'string' ? body.website.trim() : ''
  if (honeypot) {
    console.log('proof-contact-submit: honeypot triggered, silently dropping')
    return json({ ok: true })
  }

  const proofId = typeof body.proofId === 'string' ? body.proofId.trim() : ''
  const email = (typeof body.email === 'string' ? body.email.trim() : '').toLowerCase()
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!proofId || !looksLikeUuid(proofId)) return json({ error: 'Provide a valid proofId (UUID)' }, 400)
  if (!email) return json({ error: 'Email is required' }, 400)
  if (!isValidEmail(email)) return json({ error: 'Email does not look right' }, 400)
  if (!message) return json({ error: 'Message is required' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Server not configured' }, 500)

  // Service-role client — proof data lives in the `proofs` schema of
  // the shared stock project; RLS blocks anon reads on the base tables.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false },
  })

  // Validate the proof exists. This is the spam gate: without a real
  // proof id, nothing is created in Help Scout.
  const { data: proof, error: proofError } = await supabase
    .from('proofs')
    .select('id, status, contact_id, helpscout_conversation_url')
    .eq('id', proofId)
    .maybeSingle()

  if (proofError) {
    console.error('proof-contact-submit: proof read error', proofError)
    return json({ error: 'Lookup failed' }, 500)
  }
  if (!proof) return json({ error: 'Proof not found' }, 404)

  // Best-effort proof-owner enrichment for the conversation body.
  // Never fails the request — a missing contact/company just omits
  // those lines.
  let ownerName: string | null = null
  let ownerCompany: string | null = null
  if (proof.contact_id) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('full_name, company_id')
      .eq('id', proof.contact_id)
      .maybeSingle()
    ownerName = contact?.full_name ?? null
    if (contact?.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', contact.company_id)
        .maybeSingle()
      ownerCompany = company?.name ?? null
    }
  }

  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  if (!appId || !appSecret) {
    console.error('proof-contact-submit: Help Scout credentials not configured')
    return json({ error: 'Server misconfigured' }, 500)
  }

  const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const proofUrl = `${baseUrl}/p/${proofId}`
  const { firstName, lastName } = splitName(name)
  const subjectWho = ownerCompany || ownerName || name || email
  const subject = `Closed proof enquiry — ${subjectWho}`

  // Help Scout keys the customer by email; name parts are cosmetic, so
  // only send them when we actually have them (avoids posting blank
  // firstName/lastName).
  const customer: { email: string; firstName?: string; lastName?: string } = { email }
  if (firstName) customer.firstName = firstName
  if (lastName) customer.lastName = lastName

  try {
    const token = await getAccessToken(appId, appSecret)
    const mailboxId = await resolveMailboxId(token)

    const conversationPayload = {
      subject,
      type: 'email',
      status: 'active',
      mailboxId,
      customer,
      threads: [
        {
          type: 'customer',
          customer: { email },
          text: buildBody({
            message,
            email,
            name,
            proofId,
            proofStatus: proof.status ?? 'unknown',
            proofUrl,
            ownerName,
            ownerCompany,
            linkedConversationUrl: proof.helpscout_conversation_url ?? null,
          }),
        },
      ],
    }

    const resp = await fetch('https://api.helpscout.net/v2/conversations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(conversationPayload),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<body read failed>')
      console.error('proof-contact-submit: Help Scout create failed', resp.status, text)
      return json(
        {
          error: `Could not send your message. Please email ${SUPPORT_EMAIL} and we will pick it up that way.`,
        },
        502,
      )
    }

    return json({ ok: true })
  } catch (err) {
    if (err instanceof HsError) {
      console.error('proof-contact-submit: HsError', err.status, err.message)
    } else {
      console.error('proof-contact-submit: unexpected error', err)
    }
    return json(
      {
        error: `Could not send your message. Please email ${SUPPORT_EMAIL} and we will pick it up that way.`,
      },
      502,
    )
  }
})
