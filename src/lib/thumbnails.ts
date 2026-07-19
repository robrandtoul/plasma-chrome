import { supabase } from './supabase'

// Signed-URL renditions for one image, produced by the dashboard-thumbnails
// edge function:
//   thumb_url   — small (~200px) for a row / card thumbnail
//   preview_url — medium, for a hover popover
//   full_url    — the untransformed original, for a click-through lightbox
//                 where the designer is inspecting detail
export type ThumbInfo = { thumb_url: string; preview_url: string; full_url: string }

// Batch-sign small thumbnail renditions for a list of proof VERSION ids in one
// round trip, via the dashboard-thumbnails edge function.
//
// WHY THIS EXISTS. Rendering a card thumbnail used to mean downloading the
// FULL-resolution original (a ~200 KB image) and shrinking it into an 80px
// box — once per row. The edge function instead picks each version's first
// front image and signs a small ~200px rendition server-side (Supabase image
// transforms), so the browser only ever downloads the postage-stamp it shows.
// The Storage SDK only supports the transform on the SINGLE createSignedUrl()
// call, not the batch one, so doing it in the browser would be N round trips —
// this function does them server-side in one call instead.
//
// Designed never to throw: every failure path returns an empty Map so a missing
// thumbnail falls through to the caller's placeholder. Keyed by version id; a
// version whose image can't be signed is simply absent from the Map.
// Module-level URL cache, keyed by version id.
//
// WHY. The signer mints FRESH signed URLs on every call, so a caller that
// re-signs on each refetch changes every <img src> and the browser re-downloads
// every thumbnail it is already showing. The dashboard refetches on mount, on
// every tab-refocus, and after snooze/resolve writes — so the same postage
// stamps were being pulled down over and over.
//
// The edge function signs for 1 hour (SIGNED_URL_TTL); we reuse a cached URL
// for 50 minutes, leaving 10 minutes of headroom so a URL handed out just
// before expiry is still comfortably valid while it is on screen. Only the ids
// that are missing or stale are sent, so the steady-state refetch asks for
// nothing at all and resolves without a network call.
const CACHE_TTL_MS = 50 * 60 * 1000
const urlCache = new Map<string, { urls: ThumbInfo; signedAt: number }>()

export async function signThumbnails(versionIds: string[]): Promise<Map<string, ThumbInfo>> {
  const ids = Array.from(new Set(versionIds.filter((id): id is string => Boolean(id))))
  if (ids.length === 0) return new Map()

  const now = Date.now()
  const result = new Map<string, ThumbInfo>()
  const stale: string[] = []
  for (const id of ids) {
    const hit = urlCache.get(id)
    if (hit && now - hit.signedAt < CACHE_TTL_MS) result.set(id, hit.urls)
    else stale.push(id)
  }
  if (stale.length === 0) return result

  const { data, error } = await supabase.functions.invoke('dashboard-thumbnails', {
    body: { versionIds: stale },
  })
  // Failure is tolerated: callers fall through to a placeholder. Anything
  // already cached is still returned, so a blip doesn't blank the whole grid.
  if (error || !data?.thumbs) return result

  for (const [versionId, urls] of Object.entries(data.thumbs as Record<string, ThumbInfo>)) {
    if (urls?.thumb_url) {
      urlCache.set(versionId, { urls, signedAt: now })
      result.set(versionId, urls)
    }
  }
  return result
}

// Drop a version's cached URLs so the next sign call re-fetches them. Call this
// when a version's artwork actually changes (new version saved, image replaced)
// — otherwise the row would keep showing the previous thumbnail for up to the
// cache TTL.
export function invalidateThumbnail(versionId: string | null | undefined) {
  if (versionId) urlCache.delete(versionId)
}
