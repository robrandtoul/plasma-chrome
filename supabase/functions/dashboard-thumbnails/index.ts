// dashboard-thumbnails — authenticated (designer) batch thumbnail signer.
//
// WHY THIS EXISTS. The dashboard used to sign every row's thumbnail with a
// single client-side storage.createSignedUrls() batch call, then render the
// FULL-resolution original into a 72x52 box. That's the "thumbnails slow to
// load" complaint: a ~200 KB original downloaded to fill a postage stamp,
// times every row.
//
// The fix is Supabase image transforms (`?width=…` renditions). But the
// Storage SDK only supports the `transform` option on the SINGLE
// createSignedUrl() call, not the batch createSignedUrls() — and the transform
// is baked into the server-signed token, so it can't be appended client-side.
// Doing N single transform-signs from the browser would be N round trips. This
// function does them server-side in one round trip instead — the same pattern
// as customer-proof-images.
//
// It returns three renditions per current version:
//   thumb_url   — small (THUMB_WIDTH) for the row thumbnail
//   preview_url — medium (PREVIEW_WIDTH) for the hover popover
//   full_url    — the untransformed original for the click-through lightbox,
//                 where the designer is inspecting detail
// The browser only downloads preview_url on hover and full_url when the
// lightbox opens (the <img> isn't mounted until then), so signing all three
// up front only adds URL strings to the response, not image bytes.
//
// AUTH. verify_jwt = true: the Supabase platform gates this to authenticated
// staff before the function body runs (every app user is a designer/admin).
// Inside, the service role is used purely to read image rows and sign storage
// URLs — exactly what the client could already do (the dashboard signed
// proof-images URLs client-side before this), so it exposes nothing new.
//
// SECURITY INVARIANT: the unscoped `versionIds` input is safe ONLY because
// every authenticated user is staff with full read access to every proof. If
// a non-staff login is ever added (e.g. a customer portal), this becomes an
// unscoped thumbnail-enumeration oracle — gate it per-caller at that point.
//
// Contract:
//   POST { versionIds: string[] }
//   200  { thumbs: { [versionId]: { thumb_url, preview_url, full_url } } }
//        Per-image graceful degradation: a version whose image can't be
//        signed is simply omitted, and the row falls back to its initials
//        placeholder — one bad path never fails the whole response.
//   400  { error }   missing / malformed body
//   500  { error }   server / DB failure

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// 1 hour — matches the dashboard's previous client-side TTL, so tab-refocus
// behaviour (loadThumbnails re-runs on visibilitychange) is unchanged.
const SIGNED_URL_TTL = 60 * 60
// Longest-edge cap for each rendition: THUMB_WIDTH for the small row thumbnail
// (~72px box, 2x+ for retina), PREVIEW_WIDTH for the hover popover. Used as a
// SQUARE contain box (see signTransformed) so the whole card is scaled to fit
// within this edge with aspect ratio preserved — never cropped.
const THUMB_WIDTH = 200
const PREVIEW_WIDTH = 720
// Backstop so a malformed/oversized request can't ask us to sign unbounded
// work. The dashboard working set is well under this.
const MAX_VERSIONS = 1500

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function looksLikeUuid(s: unknown): s is string {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

interface ImageRow {
  proof_version_id: string
  image_path: string
  side: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let versionIds: string[] = []
  try {
    const body = await req.json()
    const raw = Array.isArray(body?.versionIds) ? body.versionIds : []
    // De-dupe + validate so obvious garbage never reaches the DB, and cap.
    versionIds = Array.from(new Set(raw.filter(looksLikeUuid))).slice(0, MAX_VERSIONS)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (versionIds.length === 0) return json({ thumbs: {} })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)

  const supabase = createClient(supabaseUrl, serviceKey, {
    // Proof data lives in the `proofs` schema of the shared stock project.
    db: { schema: 'proofs' },
    auth: { persistSession: false },
  })

  // Pull the candidate images for every requested version in one query, then
  // pick one image per version (first front-ish by sort order). QR rows are
  // excluded — they're never a meaningful thumbnail.
  const { data: imageRows, error: imgErr } = await supabase
    .from('proof_version_images')
    .select('proof_version_id, image_path, side, sort_order')
    .in('proof_version_id', versionIds)
    .eq('is_qr_code', false)
    .order('sort_order', { ascending: true })
  if (imgErr) {
    console.error('dashboard-thumbnails image lookup error:', imgErr)
    return json({ error: 'Lookup failed' }, 500)
  }

  // First image per version, preferring front / null side over back —
  // identical selection to the dashboard's previous client-side logic.
  const pathByVersion = new Map<string, string>()
  for (const r of (imageRows ?? []) as ImageRow[]) {
    if (pathByVersion.has(r.proof_version_id)) continue
    if (r.side === 'back') continue
    pathByVersion.set(r.proof_version_id, r.image_path)
  }
  for (const r of (imageRows ?? []) as ImageRow[]) {
    if (!pathByVersion.has(r.proof_version_id)) {
      pathByVersion.set(r.proof_version_id, r.image_path)
    }
  }

  const bucket = supabase.storage.from('proof-images')

  // Sign one URL with a resize transform. The transform uses resize:'contain'
  // into a SQUARE width x width box, which scales the whole image to fit within
  // that edge with aspect ratio preserved and returns it fitted-tight (no crop,
  // no letterbox padding). NB: a width-ONLY transform does NOT preserve aspect
  // here — Supabase keeps the source height and cover-crops the width down to a
  // narrow centre strip, the wrong framing for a card thumbnail (PV bug fix).
  // On any transform failure, fall back to a plain signed URL so a rendition the
  // transformer can't handle (e.g. an SVG) still shows rather than vanishing.
  async function signTransformed(path: string, width: number): Promise<string | null> {
    try {
      const { data, error } = await bucket.createSignedUrl(path, SIGNED_URL_TTL, {
        transform: { width, height: width, resize: 'contain' },
      })
      if (!error && data?.signedUrl) return data.signedUrl
    } catch (err) {
      console.error('dashboard-thumbnails transform sign error', path, width, err)
    }
    try {
      const { data } = await bucket.createSignedUrl(path, SIGNED_URL_TTL)
      return data?.signedUrl ?? null
    } catch {
      return null
    }
  }

  async function signPlain(path: string): Promise<string | null> {
    try {
      const { data } = await bucket.createSignedUrl(path, SIGNED_URL_TTL)
      return data?.signedUrl ?? null
    } catch {
      return null
    }
  }

  const entries = await Promise.all(
    Array.from(pathByVersion.entries()).map(async ([versionId, path]) => {
      const [thumb, preview, full] = await Promise.all([
        signTransformed(path, THUMB_WIDTH),
        signTransformed(path, PREVIEW_WIDTH),
        signPlain(path),
      ])
      // A row needs at least the thumb to be useful; if even that failed,
      // omit it and let the dashboard show the initials placeholder.
      if (!thumb) return null
      return [versionId, {
        thumb_url: thumb,
        preview_url: preview ?? thumb,
        full_url: full ?? preview ?? thumb,
      }] as const
    }),
  )

  const thumbs: Record<string, { thumb_url: string; preview_url: string; full_url: string }> = {}
  for (const e of entries) {
    if (e) thumbs[e[0]] = e[1]
  }

  return json({ thumbs })
})
