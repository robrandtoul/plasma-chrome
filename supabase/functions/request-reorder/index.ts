// request-reorder — the customer asks for more of the cards they already bought.
//
// Anon, called from the "Need more?" panel on the customer proof page (/p/:id)
// once their order has been with them a while (migration 000372). Opens a NEW
// Help Scout conversation in Customer Support and returns nothing but a status.
// A designer picks it up from there and sends the pay link the usual way.
//
// ── Why this is a request and not a purchase ─────────────────────────────
//
// /p/:id is deliberately broad — team sharing hands `?for=<name>` links to
// colleagues, and docs/team-sharing-feature.md says outright that "the links
// are a convenience, not security". Self-serve reordering would therefore let
// anyone ever sent the artwork spend the company's money. That is the same
// refusal migration 000367 made about the pay token, applied to the more
// consequential action. See docs/customer-reorder-spec.md §2.
//
// So, exactly as resend-pay-link:
//
//   * Nothing comes back but a status. No order id, no link, no price.
//   * Nothing is addressable. The customer is resolved server-side from the
//     proof's own contact row; the caller cannot name a recipient. The worst a
//     /p/ holder can do is cause the REAL customer's project to get a reorder
//     enquiry — a nuisance bounded by the cooldown, not a disclosure.
//
// ── Why a NEW conversation, not the proof's existing thread ──────────────
//
// Help Scout locks threads after a period of inactivity, so a reorder months or
// years later cannot reuse the original — and the reorder becomes its own
// project anyway (spec §3), which needs its own conversation. Modelled on
// proof-contact-submit, which already creates a fresh Customer Support
// conversation carrying a proof reference; NOT on send-helpscout-reply, which
// assumes a live thread.
//
// ⚠ The conversation is attributed to the project contact, because that is who
// we would reply to — but the body says plainly that it came from the proof
// page, so nobody reads it as an email the contact hand-wrote. Whoever actually
// clicked can identify themselves in the note.
//
// ── Rate limiting ────────────────────────────────────────────────────────
//
// The 000346 atomic-claim pattern, as used by resend-pay-link: the cooldown
// lives in the WHERE clause of the UPDATE that stamps it, so Postgres
// serialises concurrent callers and exactly one wins. This is the only thing
// between a widely-shared /p/ URL and a flood of conversations in the support
// queue, and it also stops two colleagues both clicking raising two jobs.
//
// ⚠ A throttled caller, an ineligible proof and a missing proof all get the
// SAME {status:'ok'} a winner does. Differing responses would turn this into an
// oracle for which proofs carry paid orders, and a customer who clicks twice
// should see reassurance rather than an error.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessToken, HsError } from '../_shared/helpscout.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Long by the standards of the resend cooldown (10 minutes) because the cost of
// a duplicate is different: a resend re-sends something the customer already
// has, whereas this raises a job someone has to work. A day means a colleague
// clicking after the first person still gets the reassuring "we've got it",
// without a second conversation landing in the queue.
const COOLDOWN_HOURS = 24

// Same resolver as proof-contact-submit / contact-form-submit: env override
// first, then a name lookup, cached per worker. Customer Support is id 33103 on
// the live account (see proof-feedback), but resolving by name means a fresh
// environment doesn't need the id seeding.
const SUPPORT_MAILBOX_NAME = 'Customer Support'
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
  const match = (data?._embedded?.mailboxes ?? []).find(
    (b) => (b.name ?? '').trim().toLowerCase() === SUPPORT_MAILBOX_NAME.toLowerCase(),
  )
  if (!match) throw new HsError(500, `Help Scout mailbox "${SUPPORT_MAILBOX_NAME}" not found`)
  cachedMailboxId = match.id
  return match.id
}

function splitName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  if (parts.length === 1) return { firstName: parts[0] }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

interface ProofRow {
  id: string
  contact_id: string | null
  contacts: { full_name: string | null; email: string | null; companies: { name: string | null } | null } | null
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid JSON' }, 400)
    }

    const proofId = String(body.proof_id ?? '')
    if (!UUID_RE.test(proofId)) return json({ error: 'invalid proof_id' }, 400)

    // Honeypot, as proof-contact-submit. A filled value is silently accepted so
    // a bot learns nothing from the response.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      console.log('[request-reorder] honeypot tripped', { proofId })
      return json({ status: 'ok' })
    }

    const rawQty = Number(body.quantity)
    const quantity = Number.isFinite(rawQty) && rawQty > 0 && rawQty <= 1_000_000
      ? Math.round(rawQty)
      : null
    // Capped rather than rejected: an over-long note is a customer being
    // thorough, not an attack, and truncating keeps their meaning.
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : ''

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)

    const admin = createClient(supabaseUrl, serviceKey, {
      db: { schema: 'proofs' },
      auth: { persistSession: false },
    })

    // ── Eligibility, decided server-side ───────────────────────────────────
    // The same function the page reads, so the button and the endpoint can
    // never disagree about who may ask. Never trust the client's view of it.
    const { data: stateRaw, error: stateErr } = await admin
      .rpc('public_get_proof_order_state', { p_proof_id: proofId })
    if (stateErr) {
      console.error('[request-reorder] state lookup failed', stateErr.message)
      return json({ error: 'could not check this project' }, 500)
    }
    const state = (stateRaw ?? {}) as { reorder_available?: boolean }
    if (state.reorder_available !== true) {
      // Not eligible — reported exactly as success, so this cannot be used to
      // enumerate which proofs carry paid orders.
      console.log('[request-reorder] not eligible', { proofId })
      return json({ status: 'ok' })
    }

    // ── Claim the cooldown ─────────────────────────────────────────────────
    const { data: claimed, error: claimErr } = await admin.rpc('claim_reorder_request', {
      p_proof_id: proofId,
      p_cooldown_hours: COOLDOWN_HOURS,
      p_quantity: quantity,
      p_note: note,
    })
    if (claimErr) {
      console.error('[request-reorder] claim failed', claimErr.message)
      return json({ error: 'could not record the request' }, 500)
    }
    if (claimed !== true) {
      // Inside the cooldown. Same shape as a win: they already asked, and the
      // page's acknowledgement is the honest answer.
      return json({ status: 'ok' })
    }

    // ── Who is this for ────────────────────────────────────────────────────
    const { data: proofRaw } = await admin
      .from('proofs')
      .select('id, contact_id, contacts ( full_name, email, companies ( name ) )')
      .eq('id', proofId)
      .maybeSingle()
    const proof = proofRaw as ProofRow | null
    const contactEmail = proof?.contacts?.email?.trim() ?? ''
    const contactName = proof?.contacts?.full_name?.trim() ?? ''
    const companyName = proof?.contacts?.companies?.name?.trim() ?? ''

    if (!contactEmail) {
      // The claim stands — see the resend-pay-link note about not turning a
      // failed send into an unlimited retry. A designer will still see the
      // stamp on the proof.
      console.error('[request-reorder] no contact email; conversation not opened', { proofId })
      return json({ status: 'ok' })
    }

    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    if (!appId || !appSecret) {
      console.error('[request-reorder] Help Scout not configured', { proofId })
      return json({ status: 'ok' })
    }

    const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')

    // ── Compose ────────────────────────────────────────────────────────────
    // Deliberately plain text and unmistakably machine-originated. The first
    // line is what a designer needs to see in the queue preview.
    const who = companyName || contactName || contactEmail
    const subject = `Reorder request — ${who}`
    const lines: string[] = []
    lines.push(
      quantity
        ? `We'd like to reorder these cards — ${quantity.toLocaleString('en-GB')} please.`
        : `We'd like to reorder these cards.`,
    )
    if (note) {
      lines.push('')
      lines.push(note)
    }
    lines.push('')
    lines.push('---')
    lines.push('Sent from the proof page’s reorder panel.')
    if (contactName) lines.push(`Project contact: ${contactName}`)
    if (companyName) lines.push(`Company: ${companyName}`)
    // The DESIGNER url, not the customer one — the audience for this metadata
    // block is whoever picks the job up, and one click to the project is the
    // whole point. It's auth-gated, so a customer who ever sees it quoted gets
    // a login page rather than anything of ours.
    if (baseUrl) lines.push(`Original project: ${baseUrl}/proofs/${proofId}`)
    // ⚠ States the FACT, never the routing decision. A note saying "same
    // again, thanks" is not a change, and a line reading "this needs a fresh
    // proof round" above it would send a designer down the long route for no
    // reason. Whether anything changed is a judgement about the words, which
    // is a person's job — see docs/customer-reorder-spec.md §6.
    lines.push(
      note
        ? 'The customer left a note (above) — worth reading before deciding whether this needs a fresh proof round.'
        : 'No changes were mentioned.',
    )

    // One token for both calls. Two getAccessToken calls means two OAuth round
    // trips on every request for no benefit.
    const token = await getAccessToken(appId, appSecret)

    const conversationPayload = {
      subject,
      type: 'email',
      // Lands in the team's Active queue, same as the closed-proof form.
      status: 'active',
      mailboxId: await resolveMailboxId(token),
      customer: { email: contactEmail, ...splitName(contactName) },
      threads: [
        {
          type: 'customer',
          customer: { email: contactEmail },
          text: lines.join('\n'),
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
      const text = await resp.text().catch(() => '')
      // The claim is already stamped and is NOT rolled back: a failed open must
      // not become an unlimited retry loop into the support queue. The stamp on
      // the proof is still the designer's signal that someone asked.
      console.error('[request-reorder] conversation create failed', resp.status, text.slice(0, 300))
      return json({ status: 'ok' })
    }

    console.log('[request-reorder] conversation opened', { proofId, quantity, hasNote: !!note })
    return json({ status: 'ok' })
  } catch (err) {
    console.error('[request-reorder] crash', (err as Error)?.message)
    return json({ error: 'crash' }, 500)
  }
})
