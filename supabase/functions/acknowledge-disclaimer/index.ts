// Record the customer's disclaimer acknowledgement against the
// proofs row.
//
// Scaffolding for the future approve-proof-version edge function
// — same shape, same IP/UA capture pattern, same idempotency
// rule. The approve function will differ only in the column
// set it writes (per-version approval columns + proofs.status
// transition) and in calling the Help Scout API to post a
// "customer approved" note on the linked thread. Keep the
// structure below stable so that function can lift the scaffold
// verbatim.
//
// Contract:
//   POST /acknowledge-disclaimer
//   body: { proofId: string }    (UUID — same id the customer
//                                  URL carries)
//
//   200 { acknowledged_at: ISO string }   on success or idempotent
//                                         re-ack of an already-
//                                         acknowledged proof
//   400 { error }                         missing / malformed
//                                         proofId
//   404 { error }                         proof not found
//   500 { error }                         server / DB failure
//
// Called by anonymous customers — no Supabase JWT on the
// request. Server authenticates the WRITE by using the service-
// role key (bypasses RLS) after validating the proof exists.
// Security posture mirrors the existing record_proof_view RPC:
// the proof URL itself is the access token; anyone with it can
// ack, and ack is idempotent + write-once so abuse is limited
// to vandalising a single row's timestamp once (and that's
// already possible via the URL).
//
// IP capture reads x-forwarded-for (Netlify / Supabase edge put
// the real client IP there); falls back to x-real-ip.
// User-agent captured verbatim.
// by_name stays null — the disclaimer ack doesn't prompt for a
// name; the future approve flow will.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// UUID v4-ish sanity check — the proof id column is a Postgres
// uuid, so anything that doesn't look like a uuid is guaranteed
// not to match a row. Keeps the 404 path cheap and the server
// from doing a full table scan on rubbish input.
function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Pull the first address out of x-forwarded-for (multiple IPs
// get comma-separated when a proxy chain is involved; the first
// is the real client). Fall back to x-real-ip. Return null when
// neither header is present — the column is nullable, so a
// null write is fine.
function extractIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  const xri = req.headers.get('x-real-ip')
  if (xri) return xri.trim() || null
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let proofId: string | undefined
  try {
    const body = await req.json()
    proofId = typeof body?.proofId === 'string' ? body.proofId.trim() : undefined
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!proofId || !looksLikeUuid(proofId)) {
    return json({ error: 'Provide a valid proofId (UUID)' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Server not configured' }, 500)
  }

  // Service-role client bypasses RLS so we can read the base
  // proofs table (RLS blocks anon reads on proofs — customer
  // sees a projection via public_proofs) and write the ack
  // columns.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })

  // Idempotency check — if the proof is already acknowledged,
  // return the existing timestamp without overwriting. Protects
  // against double-clicks, retry-after-transient-failure, and
  // any future replay scenario.
  const { data: existing, error: readError } = await supabase
    .from('proofs')
    .select('id, disclaimer_acknowledged_at')
    .eq('id', proofId)
    .maybeSingle()

  if (readError) {
    console.error('acknowledge-disclaimer read error:', readError)
    return json({ error: 'Lookup failed' }, 500)
  }
  if (!existing) {
    return json({ error: 'Proof not found' }, 404)
  }
  if (existing.disclaimer_acknowledged_at) {
    return json({ acknowledged_at: existing.disclaimer_acknowledged_at })
  }

  const ip = extractIp(req)
  const ua = req.headers.get('user-agent')
  const now = new Date().toISOString()

  const { data: updated, error: writeError } = await supabase
    .from('proofs')
    .update({
      disclaimer_acknowledged_at: now,
      disclaimer_acknowledged_from_ip: ip,
      disclaimer_acknowledged_from_ua: ua,
      // by_name intentionally left null — not captured here.
    })
    .eq('id', proofId)
    // Belt-and-braces: even with the above is-null check in JS,
    // if two requests race to ack, the .is('disclaimer_ack...',
    // null) filter here ensures only one write lands; the
    // second UPDATE matches zero rows and our final fetch
    // returns the stored timestamp from whichever request won.
    .is('disclaimer_acknowledged_at', null)
    .select('disclaimer_acknowledged_at')
    .maybeSingle()

  if (writeError) {
    console.error('acknowledge-disclaimer write error:', writeError)
    return json({ error: 'Could not save acknowledgement' }, 500)
  }

  // If `updated` came back null (race: another request set the
  // column between our read and write), fetch the stored value
  // to return whatever actually landed.
  if (!updated?.disclaimer_acknowledged_at) {
    const { data: refetched } = await supabase
      .from('proofs')
      .select('disclaimer_acknowledged_at')
      .eq('id', proofId)
      .maybeSingle()
    if (refetched?.disclaimer_acknowledged_at) {
      return json({ acknowledged_at: refetched.disclaimer_acknowledged_at })
    }
    return json({ error: 'Could not save acknowledgement' }, 500)
  }

  return json({ acknowledged_at: updated.disclaimer_acknowledged_at })
})
