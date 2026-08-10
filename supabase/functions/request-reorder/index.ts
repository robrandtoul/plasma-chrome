// request-reorder — the customer asks for more of the cards they already bought.
//
// Anon, called from TWO panels on the customer proof page (/p/:id):
//
//   * the "Need more?" panel on a delivered order (migration 000372), and
//   * the "welcome back" band on a re-engagement outreach proof (000392) — a
//     new project we made for a past customer we approached, which has artwork
//     and a customer link but no order at all.
//
// Either way it opens a NEW Help Scout conversation in Customer Support and
// returns nothing but a status. A designer picks it up from there and sends the
// pay link the usual way.
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
// ⚠ On the ORDINARY branch a throttled caller, an ineligible proof and a
// missing proof all get the SAME {status:'ok'} a winner does. Differing
// responses would turn this into an oracle for which proofs carry paid orders,
// and a customer who clicks twice should see reassurance rather than an error.
//
// On the OUTREACH branch there is no paid order to enumerate, so a throttled
// caller gets a distinguishable {status:'throttled'} and the band can say
// "you've already told us" instead of thanking them a second time for a request
// that was never recorded. Ineligible and missing proofs still answer 'ok' on
// BOTH branches, so a first call's response can never separate "outreach proof"
// from "any other proof".
//
// ⚠ If 'throttled' is ever returned on the ordinary branch too, patch
// src/pages/CustomerProofPage.tsx first — and note it re-opens the paid-order
// oracle this paragraph exists to close.

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

// What the customer is asking for. Shapes the Help Scout subject and the
// opening line ONLY — never eligibility, never the claim, never routing. It is
// ONE request either way: one claim, one conversation, one row.
//
// ⚠ Two buttons must not mean two claims. claim_reorder_request has a 24-hour
// cooldown in its own WHERE, so a second POST would lose the claim and be
// answered as though it had landed while the customer's words went nowhere.
type RequestKind = 'repeat' | 'new_person'

// A ceiling on the stored note, which now ACCUMULATES across asks (see
// composeStoredNote). Generous — a customer being thorough twice is still only
// a few hundred characters — and the overflow path keeps the EARLIER text,
// because Help Scout holds every ask verbatim and this column is only a
// designer's convenience.
const NOTE_COLUMN_MAX = 4000

/**
 * Fold a fresh ask into whatever the proof already holds.
 *
 * ⚠ claim_reorder_request writes `nullif(btrim(coalesce(p_note,'')),'')` and
 * `p_quantity` UNCONDITIONALLY, so passing the raw new values would blank a
 * genuine earlier ask the moment someone comes back weeks later with a bare
 * "yes please". Composing here keeps the fix in one place and needs no
 * migration — the claim's WHERE clause is untouched, so it stays atomic.
 *
 * The read-then-write looks like a lost-update bug and is not: two simultaneous
 * asks both read the same previous note, one wins the claim and writes, and the
 * loser is throttled and writes nothing at all. There is no interleaving in
 * which an EARLIER note is destroyed.
 */
function composeStoredNote(previous: string, incoming: string, todayIso: string): string {
  const prev = previous.trim()
  const next = incoming.trim()
  if (!prev) return next
  if (!next) return prev // a bare second ask must never blank the first note
  const joined = `${prev}\n\n— asked again ${todayIso} —\n${next}`
  if (joined.length <= NOTE_COLUMN_MAX) return joined
  // Too long to keep both in full. Record THAT they asked again and where the
  // words are, rather than truncating either ask into nonsense.
  const marker = `${prev}\n\n— asked again ${todayIso} (note in Help Scout) —`
  return marker.length <= NOTE_COLUMN_MAX ? marker : prev
}

interface ProofRow {
  id: string
  contact_id: string | null
  reengagement_context: Record<string, unknown> | null
  reorder_request_note: string | null
  reorder_request_quantity: number | null
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
    // Cosmetic, so an unrecognised value degrades to the ordinary wording
    // rather than 400ing a real customer's request over a typo'd field.
    const kind: RequestKind = body.kind === 'new_person' ? 'new_person' : 'repeat'

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)

    const admin = createClient(supabaseUrl, serviceKey, {
      db: { schema: 'proofs' },
      auth: { persistSession: false },
    })

    // ── Who is this for, and which kind of proof is it ─────────────────────
    // Read FIRST — before eligibility and before the claim. This one row
    // decides the branch, supplies what is already stored so a second ask
    // can't blank it, and names the customer. (It used to sit after the claim,
    // where a fault in it was invisible; now a transient DB error is reported
    // and nothing is stamped, so the customer can simply try again.)
    //
    // ⚠ Single literal in .select(): supabase-js parses the string as a TYPE,
    // and a joined expression it cannot read statically collapses the row to an
    // error type.
    const { data: proofRaw, error: proofErr } = await admin
      .from('proofs')
      .select('id, contact_id, reengagement_context, reorder_request_note, reorder_request_quantity, contacts ( full_name, email, companies ( name ) )')
      .eq('id', proofId)
      .maybeSingle()
    if (proofErr) {
      // A server fault, not a per-proof answer — safe to report as itself.
      console.error('[request-reorder] proof lookup failed', proofErr.message)
      return json({ error: 'could not check this project' }, 500)
    }
    const proof = proofRaw as ProofRow | null
    if (!proof) {
      // Unknown proof reports exactly as success — a 404 here would let a
      // caller sweep for live proof ids.
      console.log('[request-reorder] no such proof', { proofId })
      return json({ status: 'ok' })
    }
    const contactEmail = proof.contacts?.email?.trim() ?? ''
    const contactName = proof.contacts?.full_name?.trim() ?? ''
    const companyName = proof.contacts?.companies?.name?.trim() ?? ''

    // The re-engagement branch (000392). An outreach proof is a NEW project we
    // made for a past customer we approached: it has artwork and a customer
    // link but no row in proofs.orders at all, so the order-state RPC's whole
    // order-shaped branch collapses to {"state":"none"} and reorder_available
    // is ABSENT. Before this, the welcome band's ask hit the check below and
    // was answered with the same cheerful ok a winner gets — the worst possible
    // failure, because the page then told the customer we had it.
    //
    // ⚠ Keyed on reengagement_context, NEVER reengagement_prospect_id. That
    // column is ON DELETE SET NULL, and the only outreach proof on live today
    // already carries a context with a null prospect id — a prospect-id gate
    // would reject 100% of the population while looking correct in review.
    const context = proof.reengagement_context
    const isOutreach = context != null

    // ── Eligibility, decided server-side ───────────────────────────────────
    if (!isOutreach) {
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
    }
    // An outreach proof needs no order state — it has none. Skipping the call
    // also means a transient RPC fault can't swallow an outreach ask.

    // ── Claim the cooldown ─────────────────────────────────────────────────
    // ONE claim, whatever the kind. Two kinds are two wordings of a single
    // request, never two competing writes to the same row.
    const todayIso = new Date().toISOString().slice(0, 10)
    const storedNote = composeStoredNote(proof.reorder_request_note ?? '', note, todayIso)
    // A bare second ask keeps the first quantity rather than nulling it; a
    // named quantity is their latest word and wins.
    const storedQuantity = quantity ?? proof.reorder_request_quantity ?? null

    const { data: claimed, error: claimErr } = await admin.rpc('claim_reorder_request', {
      p_proof_id: proofId,
      p_cooldown_hours: COOLDOWN_HOURS,
      p_quantity: storedQuantity,
      p_note: storedNote,
    })
    if (claimErr) {
      console.error('[request-reorder] claim failed', claimErr.message)
      return json({ error: 'could not record the request' }, 500)
    }
    if (claimed !== true) {
      // Inside the cooldown. On an outreach proof there is no paid order to
      // enumerate, so we can afford to be honest and let the band say "you've
      // already told us" rather than thanking them a second time for nothing.
      // Ordinary proofs keep the uniform ok — differing responses there would
      // turn this into an oracle for which proofs carry paid orders.
      console.log('[request-reorder] throttled', { proofId, isOutreach })
      return json({ status: isOutreach ? 'throttled' : 'ok' })
    }

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
    // "Reorder request" stays the scannable prefix on both kinds so the queue
    // still groups; the qualifier only tells the designer what to expect.
    const subject = kind === 'new_person'
      ? `Reorder request (new details) — ${who}`
      : `Reorder request — ${who}`
    const qtyText = quantity ? ` — ${quantity.toLocaleString('en-GB')} please` : ''
    const lines: string[] = []
    lines.push(
      kind === 'new_person'
        ? `We'd like more cards, but with new details${qtyText}.`
        : `We'd like to reorder these cards${qtyText}.`,
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
    // Outreach only, and only ever from the server-read context — the caller
    // cannot inject a word of this. It is the same display-safe snapshot the
    // band itself renders, so it saves the designer a lookup before quoting.
    if (isOutreach) {
      const lastSpec = typeof context?.last_spec === 'string' ? context.last_spec.trim().slice(0, 200) : ''
      const lastOn = typeof context?.last_order_on === 'string' ? context.last_order_on.trim().slice(0, 20) : ''
      if (lastSpec) lines.push(`Last order: ${lastSpec}${lastOn ? ` (${lastOn})` : ''}`)
      lines.push('Came from a re-engagement outreach — there is no live order on this project.')
    }
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
    //
    // The new_person wording is still a FACT, not a judgement: the customer
    // picked that option themselves. Leaving "No changes were mentioned." here
    // would flatly contradict the opening line above it.
    lines.push(
      note
        ? 'The customer left a note (above) — worth reading before deciding whether this needs a fresh proof round.'
        : kind === 'new_person'
          ? 'They said the details need changing; nothing further was written.'
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

    // ── Tell the Reorder desk to stand down ────────────────────────────────
    // The customer HAS answered the outreach — just through the band instead of
    // by email. Nothing else records that: creating a conversation fires
    // convo.created, and helpscout-webhook stamps only on reply events, on a
    // conversation id no proof holds. Without this the desk reads the reply as
    // silence and either chases again (followUps) or quietly closes the project
    // (quietCloses → status 'abandoned'), which would break the very page they
    // just used. src/lib/reorderDesk.ts customerRepliedSinceContact() reads
    // exactly this column.
    //
    // Outreach only: ordinary reorder proofs are approved-and-paid, are not on
    // the desk, and stamping them would quiet the 000208 chase-rule grace
    // window for no reason.
    //
    // Best-effort but AWAITED — a stamp failure must not cost the customer
    // their request, but a bare `void` builder would never send at all (see
    // CLAUDE.md, "supabase-js queries are lazy").
    if (isOutreach) {
      const stampIso = new Date().toISOString()
      const { error: stampErr } = await admin
        .from('proofs')
        .update({ helpscout_last_customer_reply_at: stampIso })
        .eq('id', proofId)
        // The same GREATEST guard helpscout-webhook uses: a genuine later email
        // reply must never be regressed by a retried request.
        .or(`helpscout_last_customer_reply_at.is.null,helpscout_last_customer_reply_at.lt.${stampIso}`)
      if (stampErr) {
        console.error('[request-reorder] reply stamp failed', stampErr.message)
      }
    }

    console.log('[request-reorder] conversation opened', {
      proofId,
      kind,
      isOutreach,
      quantity,
      hasNote: !!note,
    })
    return json({ status: 'ok' })
  } catch (err) {
    console.error('[request-reorder] crash', (err as Error)?.message)
    return json({ error: 'crash' }, 500)
  }
})
