// Public contact-form endpoint for the Squarespace support page.
//
// Receives a multipart/form-data submission from the form embedded at
// https://www.plasmadesign.co.uk/support, runs two spam checks, then
// creates a Help Scout conversation in the Customer Support mailbox
// with the visitor as the customer. Replaces the Cognito Forms +
// Gmail forwarding hop.
//
// Anon-callable: the form is on a public page, so this function does
// not require a Supabase JWT. Spam protection layers:
//   1. Honeypot field — must be empty (legitimate submissions never
//      fill it; bots that submit every input do).
//   2. Cloudflare Turnstile — token re-verified server-side against
//      challenges.cloudflare.com/turnstile/v0/siteverify so a bot
//      that hands us a forged or replayed token is rejected.
//   3. CORS Access-Control-Allow-Origin pinned to the marketing site
//      so a browser-side caller can't be hosted elsewhere.
//
// Configure verify_jwt = false in supabase/config.toml and deploy
// with --no-verify-jwt so the platform skips its JWT check.
//
// Required secrets (set via supabase secrets set …):
//   * HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET — already present, used
//     by the existing Help Scout edge functions.
//   * TURNSTILE_SECRET_KEY — new. The Cloudflare Turnstile secret
//     key (NOT the site key, which lives in the form JS).
//
// Optional secrets:
//   * HELPSCOUT_SUPPORT_MAILBOX_ID — short-circuits the mailbox
//     lookup. Useful if the lookup ever drifts because the mailbox
//     is renamed in Help Scout.

import { getAccessToken, HsError } from '../_shared/helpscout.ts'

const ALLOWED_ORIGIN = 'https://www.plasmadesign.co.uk'
const SUPPORT_MAILBOX_NAME = 'Customer Support'
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB raw upload cap
const ALLOWED_MIME_PREFIXES = ['image/']
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
])

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function badRequest(message: string) {
  return json({ error: message }, 400)
}

// Verify the Turnstile token directly with Cloudflare. The token is
// single-use and tied to the issuing site key + the visitor's IP, so
// even a leaked token is useless after one verify or off-network. We
// pass the visitor IP from CF-Connecting-IP / X-Forwarded-For when
// present; Turnstile uses it for the bot-score correlation but
// tolerates absence (returns "success: true" with a "missing-input
// -remoteip" hint we ignore).
async function verifyTurnstile(token: string, secret: string, remoteip: string | null): Promise<boolean> {
  const body = new URLSearchParams()
  body.set('secret', secret)
  body.set('response', token)
  if (remoteip) body.set('remoteip', remoteip)
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    console.error('Turnstile verify HTTP error', resp.status, await resp.text().catch(() => ''))
    return false
  }
  const data = await resp.json().catch(() => null) as { success?: boolean; 'error-codes'?: string[] } | null
  if (!data?.success) {
    console.warn('Turnstile verify rejected', data?.['error-codes'] ?? [])
    return false
  }
  return true
}

// Resolve the Customer Support mailbox id once per worker process.
// Cached in module scope so warm invocations don't repeat the API
// call. HELPSCOUT_SUPPORT_MAILBOX_ID env var short-circuits the
// lookup entirely (useful if the mailbox is ever renamed).
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
  const data = await resp.json().catch(() => null) as
    | { _embedded?: { mailboxes?: Array<{ id: number; name?: string }> } }
    | null
  const boxes = data?._embedded?.mailboxes ?? []
  const match = boxes.find((b) => (b.name ?? '').trim().toLowerCase() === SUPPORT_MAILBOX_NAME.toLowerCase())
  if (!match) {
    throw new HsError(500, `Help Scout mailbox "${SUPPORT_MAILBOX_NAME}" not found`)
  }
  cachedMailboxId = match.id
  return match.id
}

// Build a single email-style block of metadata so whoever picks up
// the conversation in Help Scout sees company / phone / country
// without needing to open a custom field somewhere else. Optional
// values are skipped rather than printed as blanks.
function buildBody(input: {
  message: string
  company: string
  phone: string
  country: string
  email: string
  firstName: string
  lastName: string
}): string {
  const lines: string[] = []
  lines.push(input.message.trim())
  lines.push('')
  lines.push('---')
  lines.push(`Name: ${input.firstName} ${input.lastName}`.trim())
  lines.push(`Email: ${input.email}`)
  if (input.company) lines.push(`Company: ${input.company}`)
  if (input.phone) lines.push(`Phone: ${input.phone}`)
  lines.push(`Country: ${input.country}`)
  lines.push('')
  lines.push('Submitted via the support form at plasmadesign.co.uk/support.')
  return lines.join('\n')
}

// Base64-encode a Uint8Array. We chunk rather than spreading the
// whole array into String.fromCharCode (which blows the call stack
// past a few hundred KB) — see MDN's "btoa with binary" note.
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function isAllowedMime(mime: string): boolean {
  const m = mime.toLowerCase()
  if (ALLOWED_MIME_EXACT.has(m)) return true
  return ALLOWED_MIME_PREFIXES.some((p) => m.startsWith(p))
}

function trimToString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isValidEmail(email: string): boolean {
  // Permissive shape check — Help Scout will reject anything truly
  // malformed at the customer-creation step, so we just want to
  // catch obvious typos client-side first and accept everything
  // else through.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Parse the multipart payload. FormData is the natural shape for a
  // form that sometimes carries a file — sticking to it on the wire
  // means the form JS can do `fetch(url, { body: new FormData(form) })`
  // with zero serialisation.
  let form: FormData
  try {
    form = await req.formData()
  } catch (err) {
    console.warn('contact-form-submit: invalid multipart body', err)
    return badRequest('Invalid form submission')
  }

  // Honeypot — a hidden text input named "website". Real visitors
  // never see or touch it; bots that auto-fill every input give
  // themselves away. Silent 200 so a bot can't tell its submission
  // was rejected (and won't retry with the field cleared).
  const honeypot = trimToString(form.get('website'))
  if (honeypot) {
    console.log('contact-form-submit: honeypot triggered, silently dropping')
    return json({ ok: true })
  }

  const firstName = trimToString(form.get('firstName'))
  const lastName = trimToString(form.get('lastName'))
  const email = trimToString(form.get('email')).toLowerCase()
  const company = trimToString(form.get('company'))
  const phone = trimToString(form.get('phone'))
  const country = trimToString(form.get('country'))
  const subject = trimToString(form.get('subject'))
  const message = trimToString(form.get('message'))
  const turnstileToken = trimToString(form.get('cf-turnstile-response'))

  if (!firstName) return badRequest('First name is required')
  if (!lastName) return badRequest('Last name is required')
  if (!email) return badRequest('Email is required')
  if (!isValidEmail(email)) return badRequest('Email does not look right')
  if (!country) return badRequest('Country is required')
  if (!subject) return badRequest('Subject is required')
  if (!message) return badRequest('Message is required')
  if (!turnstileToken) return badRequest('Spam check missing — please complete the challenge and try again')

  // Optional attachment. We allow a single file to keep the storage
  // surface narrow; Help Scout supports more but the form scope here
  // is "attach a screenshot or PDF", not multi-file upload.
  const fileEntry = form.get('attachment')
  let attachment: { fileName: string; mimeType: string; data: string } | null = null
  if (fileEntry instanceof File && fileEntry.size > 0) {
    if (fileEntry.size > MAX_FILE_BYTES) {
      return badRequest(`Attachment too large — max ${MAX_FILE_BYTES / (1024 * 1024)} MB`)
    }
    const mime = fileEntry.type || 'application/octet-stream'
    if (!isAllowedMime(mime)) {
      return badRequest('Attachment type not allowed (images, PDF, Word and text only)')
    }
    const bytes = new Uint8Array(await fileEntry.arrayBuffer())
    attachment = {
      fileName: fileEntry.name || 'attachment',
      mimeType: mime,
      data: uint8ToBase64(bytes),
    }
  }

  // Turnstile verify — pass the visitor IP if the platform set
  // either header (Supabase sets x-forwarded-for via the edge proxy).
  const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')?.trim()
  if (!turnstileSecret) {
    console.error('contact-form-submit: TURNSTILE_SECRET_KEY not configured')
    return json({ error: 'Server misconfigured' }, 500)
  }
  const remoteip =
    req.headers.get('cf-connecting-ip') ??
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    null
  const turnstileOk = await verifyTurnstile(turnstileToken, turnstileSecret, remoteip)
  if (!turnstileOk) {
    return badRequest('Spam check failed — please reload and try again')
  }

  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  if (!appId || !appSecret) {
    console.error('contact-form-submit: Help Scout credentials not configured')
    return json({ error: 'Server misconfigured' }, 500)
  }

  try {
    const token = await getAccessToken(appId, appSecret)
    const mailboxId = await resolveMailboxId(token)

    const thread: Record<string, unknown> = {
      type: 'customer',
      customer: { email },
      text: buildBody({ message, company, phone, country, email, firstName, lastName }),
    }
    if (attachment) thread.attachments = [attachment]

    const conversationPayload = {
      subject,
      type: 'email',
      status: 'active',
      mailboxId,
      customer: {
        email,
        firstName,
        lastName,
      },
      threads: [thread],
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
      console.error('contact-form-submit: Help Scout create failed', resp.status, text)
      // Don't leak Help Scout's response shape to the caller; the
      // visitor just needs to know something went wrong so they can
      // fall back to the support@ mailto.
      return json({ error: 'Could not create a support conversation. Please email support@plasmadesign.co.uk and we will pick it up that way.' }, 502)
    }

    return json({ ok: true })
  } catch (err) {
    if (err instanceof HsError) {
      console.error('contact-form-submit: HsError', err.status, err.message)
    } else {
      console.error('contact-form-submit: unexpected error', err)
    }
    return json({ error: 'Could not create a support conversation. Please email support@plasmadesign.co.uk and we will pick it up that way.' }, 502)
  }
})
