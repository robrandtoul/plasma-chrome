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
export async function signThumbnails(versionIds: string[]): Promise<Map<string, ThumbInfo>> {
  const ids = Array.from(new Set(versionIds.filter((id): id is string => Boolean(id))))
  if (ids.length === 0) return new Map()

  const { data, error } = await supabase.functions.invoke('dashboard-thumbnails', {
    body: { versionIds: ids },
  })
  if (error || !data?.thumbs) return new Map()

  const byVersion = new Map<string, ThumbInfo>()
  for (const [versionId, urls] of Object.entries(data.thumbs as Record<string, ThumbInfo>)) {
    if (urls?.thumb_url) byVersion.set(versionId, urls)
  }
  return byVersion
}
