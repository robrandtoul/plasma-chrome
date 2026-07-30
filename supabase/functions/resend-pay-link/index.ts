// resend-pay-link — the customer asks for their payment link again.
//
// Anon, called from the "Ready to order?" card on the customer proof page
// (/p/:id). Re-posts the EXISTING pay link onto the proof's linked Help Scout
// conversation — the same channel a designer sends down — and returns nothing
// but a status.
//
// ── The security shape, which is the whole design ────────────────────────
//
// The request body is `{ proof_id }` and NOTHING else. No token, no order id,
// no email address. That is deliberate on both ends:
//
//   * Nothing comes back. The response is {status:'ok'}; the pay URL is never
//     in it. /p/:id is shared broadly — team sharing hands `?for=<name>` links
//     to colleagues, and docs/team-sharing-feature.md says outright that "the
//     links are a convenience, not security" — while the pay page is gated by
//     a second bearer token precisely because a holder can pay, redirect the
//     parcel, write a customs tax id, and rewrite the order's quantity /
//     thickness / finish without paying. Publishing that token to every proof
//     viewer would collapse the two populations into one. See migration
//     000367's header and src/lib/customerProofUrl.ts:26-34.
//
//   * Nothing is addressable. The recipient is resolved server-side from the
//     proof's own Help Scout conversation. A caller cannot name a destination,
//     so the worst a /p/ link holder can do is cause the REAL customer to
//     receive their own link — a nuisance bounded by the cooldown below, not a
//     disclosure.
//
// Proof id alone is therefore sufficient authorisation: it is the credential
// for the page this button lives on, and the action reveals nothing to whoever
// holds it. (Contrast order-question, which needs the pay token because it
// writes customer-authored text into the staff queue.)
//
// ── Rate limiting ────────────────────────────────────────────────────────
//
// This repo had no inbound rate-limiting primitive when this was written —
// order-question, the closest anon precedent, has none at all. The limiter
// here is the 000346 atomic-claim pattern: the cooldown lives in the WHERE
// clause of the UPDATE that stamps it, so Postgres serialises concurrent
// callers on the row and exactly one wins. No read-then-write race, no lock.
//
// Two deliberate differences from 000346: the stamp is never cleared and is
// NOT rolled back when Help Scout fails, because a failed send must not
// become an unlimited retry loop into the customer's thread; and a throttled
// caller gets the SAME {status:'ok'} a winner does, so the endpoint cannot be
// used to probe which proofs carry live orders, and a customer who clicks
// twice sees reassurance rather than an error.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessToken, fetchConversation, postStaffReply } from '../_shared/helpscout.ts'
import { renderTemplate, type TemplateContext } from '../_shared/replyTemplates.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// How long before the same payable can be re-sent again. Long enough that a
// double-click or an impatient refresh cannot fan out into the thread, short
// enough that someone who genuinely didn't receive it isn't stuck for the
// afternoon.
const COOLDOWN_MINUTES = 10

// Fallback if the seeded template row is missing (000369 seeds it). Mirrors
// that migration's body and DEFAULT_BODIES in src/lib/replyTemplates.ts.
const RESEND_DEFAULT_BODY =
  `Hi{? first_name} {first_name}{/?},\n\nNo problem — here's the link to order your cards again. You can choose your quantity, confirm delivery, and pay securely here:\n\n{order_url}\n\nIf it keeps not arriving, just reply to this email and we'll sort it out another way.`

// What proofs.claim_pay_link_resend hands back. Everything needed to compose
// and send, resolved and claimed in ONE statement so the cooldown cannot be
// raced — see that function's comment.
interface Claim {
  outcome: 'claimed' | 'throttled' | 'unavailable'
  target?: 'order' | 'group'
  target_id?: string
  token?: string
  conversation_id?: string
  first_name?: string
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)

    const admin = createClient(supabaseUrl, serviceKey, {
      db: { schema: 'proofs' },
      auth: { persistSession: false },
    })

    const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
    if (!baseUrl) return json({ status: 'unavailable' })

    // ── Resolve + claim, in one atomic statement ───────────────────────────
    // Which of the order or its group is payable, and the cooldown claim, are
    // decided together in SQL (000369). Doing it here in TypeScript would mean
    // a read-then-write race on the thing that stops a shared /p/ URL fanning
    // out into someone's inbox.
    const { data: claimRaw, error: claimErr } = await admin
      .rpc('claim_pay_link_resend', { p_proof_id: proofId, p_cooldown_minutes: COOLDOWN_MINUTES })
    if (claimErr) return json({ error: 'could not record the request' }, 500)

    const claim = (claimRaw ?? { outcome: 'unavailable' }) as Claim

    // Nothing payable, or nowhere to send it — say so plainly rather than
    // claiming a send. The page falls back to its "reply to any message from
    // us" copy.
    if (claim.outcome === 'unavailable') return json({ status: 'unavailable' })

    // Inside the cooldown. Reported exactly as a success: they already got
    // what they asked for, and an identical response shape stops the endpoint
    // being used to probe which proofs carry live orders.
    if (claim.outcome !== 'claimed' || !claim.token || !claim.conversation_id) {
      return json({ status: 'ok' })
    }

    const conversationId = claim.conversation_id

    // ── Compose ────────────────────────────────────────────────────────────
    const { data: tpl } = await admin
      .from('reply_templates')
      .select('body')
      .eq('id', 'order_link_resend')
      .maybeSingle()
    const templateBody = (tpl?.body as string | undefined)?.trim() || RESEND_DEFAULT_BODY

    const path = claim.target === 'group'
      ? `/order/group/${claim.target_id}`
      : `/order/${claim.target_id}`

    const ctx: TemplateContext = {
      first_name: claim.first_name ?? '',
      order_url: `${baseUrl}${path}?token=${encodeURIComponent(claim.token)}`,
    }
    const text = renderTemplate(templateBody, ctx)

    // ── Send ───────────────────────────────────────────────────────────────
    // Off the request path: the customer's click should not wait on Help
    // Scout, and a Help Scout failure must not read as "your click failed"
    // when the claim is already stamped and will not be retried.
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    const defaultUserId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim() ?? '')
    if (!appId || !appSecret) return json({ status: 'unavailable' })

    const send = async () => {
      try {
        const token = await getAccessToken(appId, appSecret)
        const conv = await fetchConversation(token, conversationId)
        const senderId = conv?.assignee?.id
          ?? (Number.isInteger(defaultUserId) && defaultUserId > 0 ? defaultUserId : null)
        const customerId = conv?.primaryCustomer?.id
        if (!senderId || !customerId) {
          console.error('[resend-pay-link] no sender/customer identity', { proofId, conversationId })
          return
        }
        await postStaffReply(token, conversationId, { text, userId: senderId, customerId })
      } catch (err) {
        // Best-effort by design. The stamp stands, so this does not retry;
        // the customer's fallback is the card's "reply to any message" line.
        console.error('[resend-pay-link] send failed', (err as Error)?.message)
      }
    }

    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime
    if (runtime?.waitUntil) runtime.waitUntil(send())
    else await send()

    return json({ status: 'ok' })
  } catch (err) {
    // Deliberately opaque: this function's internals include the pay URL.
    console.error('[resend-pay-link] crash', (err as Error)?.message)
    return json({ error: 'crash' }, 500)
  }
})
