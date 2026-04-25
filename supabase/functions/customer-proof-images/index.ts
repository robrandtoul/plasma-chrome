// Anon-callable. Replaces the proof viewer's previous direct
// supabase.storage.from('proof-images').createSignedUrl(...)
// loop. Same access model as acknowledge-disclaimer: the proof
// URL itself is the access token; this function validates the
// proof exists, fetches its image rows from
// public_proof_version_images using service-role, and signs
// URLs server-side so the bucket can stay locked down to
// authenticated designers + this single egress path.
//
// Closes audit finding H1 — without this function, the only
// way to give the customer page image access was an anon SELECT
// policy on storage.objects, which (as a side effect) permitted
// listing every path in the bucket. With the function in place
// the policy can be dropped and the bucket effectively becomes
// private to staff.
//
// Contract:
//   POST /customer-proof-images
//   body: { proofId: UUID }
//
//   200 { images: GridImage[] }    populated. Per-image graceful
//                                  degradation: if a single
//                                  signed-URL call fails, the
//                                  image's signed_url is '' but
//                                  the rest of the response
//                                  still returns. Matches the
//                                  pre-shipment behaviour where
//                                  one bad path didn't kill the
//                                  whole page render.
//   400 { error }                  missing or malformed proofId
//   404 { error }                  proof not found
//   500 { error }                  server / DB failure
//
// Called anonymously — no Supabase JWT required. Same security
// posture as record_proof_view and acknowledge-disclaimer: the
// proof UUID acts as the access token.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// 24 hours — matches the pre-shipment SIGNED_URL_TTL on the
// customer page so cache warmup and sticky-tab open behaviour
// stay equivalent. The bucket itself is private; signed URLs
// are the only egress path.
const SIGNED_URL_TTL = 60 * 60 * 24

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// UUID v4-ish sanity check — anything that doesn't match a UUID
// is guaranteed not to match a row, so the 400 path is cheap
// and avoids a DB round-trip for obvious garbage input.
function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let proofId = ''
  try {
    const body = await req.json()
    proofId = typeof body?.proofId === 'string' ? body.proofId.trim() : ''
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!proofId || !looksLikeUuid(proofId)) {
    return json({ error: 'Provide a valid proofId (UUID)' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server not configured' }, 500)
  }

  // Service-role client. Bypasses RLS for the image lookup,
  // which is essential because public_proof_version_images is
  // already PII-clean but we still need stable access regardless
  // of any future RLS tightening on the views themselves.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  // Validate the proof exists. public_proofs is the customer-
  // facing view (gated to anon by the existing grant); a
  // missing row is the right 404 signal. Using the view rather
  // than the base table also future-proofs against the
  // base-table RLS picking up a tighter posture later.
  const { data: proof, error: proofErr } = await supabase
    .from('public_proofs')
    .select('id')
    .eq('id', proofId)
    .maybeSingle()
  if (proofErr) {
    console.error('customer-proof-images proof lookup error:', proofErr)
    return json({ error: 'Lookup failed' }, 500)
  }
  if (!proof) return json({ error: 'Proof not found' }, 404)

  // Resolve every version_id under this proof, then pull every
  // image row across those versions. Two-step rather than a
  // single join because the view shape doesn't surface the
  // proof_id on the images view directly.
  const { data: versions, error: versionsErr } = await supabase
    .from('public_proof_versions')
    .select('id')
    .eq('proof_id', proofId)
  if (versionsErr) {
    console.error('customer-proof-images versions lookup error:', versionsErr)
    return json({ error: 'Lookup failed' }, 500)
  }
  const versionIds = (versions ?? []).map((v) => v.id as string)
  if (versionIds.length === 0) return json({ images: [] })

  const { data: imageRows, error: imgErr } = await supabase
    .from('public_proof_version_images')
    .select('*')
    .in('proof_version_id', versionIds)
    .order('sort_order')
  if (imgErr) {
    console.error('customer-proof-images image lookup error:', imgErr)
    return json({ error: 'Lookup failed' }, 500)
  }

  // Sign each image. Per-image graceful degradation: if a
  // single signing call fails, that image's signed_url is the
  // empty string but the rest of the response still returns
  // populated URLs. Matches the pre-shipment frontend
  // behaviour where one missing URL didn't kill the page.
  // Promise.all over independent calls; error-trapping is
  // per-iteration via the empty-string fallback.
  const signed = await Promise.all((imageRows ?? []).map(async (img) => {
    try {
      const { data, error } = await supabase.storage
        .from('proof-images')
        .createSignedUrl((img as { image_path: string }).image_path, SIGNED_URL_TTL)
      if (error || !data?.signedUrl) return { ...img, signed_url: '' }
      return { ...img, signed_url: data.signedUrl }
    } catch (err) {
      console.error(
        'customer-proof-images signing error for path',
        (img as { image_path: string }).image_path,
        err,
      )
      return { ...img, signed_url: '' }
    }
  }))

  return json({ images: signed })
})
