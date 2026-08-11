// Fetch an old order folder's proofs from Dropbox and get them ready to add.
//
// The designer pastes something that identifies the folder; the edge function
// returns a shortlist with a direct download link each; this fetches those,
// takes the price panel off with the crop engine, and hands back candidates for
// the designer to tick. Nothing is added without them ticking it.
//
// Two rules run through the whole file, and both exist because the alternative
// silently produces a worse proof rather than an error:
//
//   1. A file that cannot be read is REPORTED, never dropped and never treated
//      as "no panel found". Some archived proofs are Photoshop files with a
//      .jpg extension — two turned up in a 215-file survey — and the browser
//      cannot decode them. Skipping them quietly would shorten the contact
//      sheet with nothing to say a proof went missing; calling them clean would
//      be worse still, since the reason a panel matters is that it carries
//      prices.
//   2. Everything is a suggestion. The crop is shown next to the original so
//      the designer can see what was taken off before they accept it.

import { detectProofPanel, cropProofPanel, type PanelDetection } from './proofPanelCrop'
import { supabase } from './supabase'
import { extractServerError } from './edgeError'

export interface ImportCandidate {
  /** Stable id for React keys and tick bookkeeping. */
  id: string
  name: string
  /** Why the server shortlisted it, e.g. "named Proof…". */
  why: string
  /** What the designer would actually add. Null when the image failed to load. */
  file: File | null
  /** Object URL of `file`, or of the original when no crop was made. */
  previewUrl: string | null
  /** Object URL of the untouched image, for the before/after comparison. */
  originalUrl: string | null
  /** Null when the image could not be read at all. */
  panel: PanelDetection | null
  /** Set when this one could not be fetched or decoded. */
  error: string | null
}

export interface ImportResult {
  folderName: string
  orderNumber: string | null
  /** Plain-English account of how the shortlist was arrived at. */
  basis: string
  candidates: ImportCandidate[]
  /** Files the server left out, with reasons. Shown so nothing looks complete. */
  skipped: { name: string; reason: string }[]
  error: string | null
}

/**
 * How many images to fetch and crop at once.
 *
 * Each one is a network fetch plus a pass over a megapixel of image data, and a
 * 40-recipient job really does hold 40 of them. Unbounded parallelism makes the
 * tab unresponsive at exactly the moment the designer is waiting to look at
 * something; four keeps it moving and finishes a typical folder quickly.
 */
const CONCURRENCY = 4

interface ServerPayload {
  ok?: boolean
  error?: string
  folder_name?: string
  order_number?: string | null
  basis?: string
  files?: ServerFile[]
  skipped?: { name: string; reason: string }[]
}

interface ServerFile {
  name: string
  path: string
  size: number
  why: string
  link: string | null
  error: string | null
}

/** Fetch one image, work out whether it carries a panel, and crop if so. */
async function prepare(f: ServerFile, signal?: AbortSignal): Promise<ImportCandidate> {
  const base: ImportCandidate = {
    id: f.path || f.name,
    name: f.name,
    why: f.why,
    file: null,
    previewUrl: null,
    originalUrl: null,
    panel: null,
    error: null,
  }

  if (!f.link) return { ...base, error: f.error ?? 'Could not fetch this file from Dropbox.' }

  let blob: Blob
  try {
    const res = await fetch(f.link, { signal })
    if (!res.ok) return { ...base, error: `Dropbox returned ${res.status} for this file.` }
    blob = await res.blob()
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    return { ...base, error: 'Could not download this file.' }
  }

  const panel = await detectProofPanel(blob)
  const originalUrl = URL.createObjectURL(blob)

  // A panel was found: crop it. If the crop itself fails the original is still
  // offered, flagged — a designer can crop by hand, but only if they can see
  // the image at all.
  if (panel.hasPanel && panel.cutX != null) {
    const cropped = await cropProofPanel(blob, panel.cutX, f.name)
    if (cropped) {
      return { ...base, file: cropped, previewUrl: URL.createObjectURL(cropped), originalUrl, panel }
    }
    return {
      ...base,
      file: new File([blob], f.name, { type: blob.type || 'image/jpeg' }),
      previewUrl: originalUrl,
      originalUrl,
      panel,
      error: 'Found the price panel but could not crop it — check this one by hand.',
    }
  }

  // No panel, or the image could not be read. detectProofPanel reports the
  // second as `unsure` precisely so it does not read as a confident "clean".
  const asFile = new File([blob], f.name, { type: blob.type || 'image/jpeg' })
  return {
    ...base,
    file: asFile,
    previewUrl: originalUrl,
    originalUrl,
    panel,
    error: panel.confidence === 'unsure' && !panel.hasPanel ? panel.reason : null,
  }
}

/** Run tasks with a ceiling on how many are in flight at once. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Read an order folder and prepare its proofs.
 *
 * `input` is whatever the designer pasted — a shared link, a Dropbox web
 * address, a path, or the folder name. The server decides which it is.
 */
export async function importOrderProofs(input: string, opts?: { signal?: AbortSignal }): Promise<ImportResult> {
  const empty: ImportResult = {
    folderName: '',
    orderNumber: null,
    basis: '',
    candidates: [],
    skipped: [],
    error: null,
  }

  let payload: ServerPayload | null = null

  try {
    const { data, error } = await supabase.functions.invoke('dropbox-order-proofs', { body: { input } })
    if (error) {
      // supabase-js leaves `data` null on any non-2xx, so the function's own
      // message is only reachable through the error's context.
      return { ...empty, error: await extractServerError(error, 'Could not read that Dropbox folder.') }
    }
    payload = (data ?? null) as ServerPayload | null
  } catch {
    return { ...empty, error: 'Could not reach Dropbox just now.' }
  }

  if (!payload?.ok) {
    return { ...empty, error: payload?.error ?? 'Could not read that Dropbox folder.' }
  }

  const files = Array.isArray(payload.files) ? payload.files : []
  const candidates = await pooled(files, CONCURRENCY, (f) => prepare(f, opts?.signal))

  return {
    folderName: payload.folder_name ?? '',
    orderNumber: payload.order_number ?? null,
    basis: payload.basis ?? '',
    candidates,
    skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
    error: null,
  }
}

/** Release the object URLs a result is holding. Call when the panel closes. */
export function releaseCandidates(candidates: ImportCandidate[]): void {
  for (const c of candidates) {
    if (c.previewUrl) URL.revokeObjectURL(c.previewUrl)
    // previewUrl and originalUrl are the same object when no crop was made;
    // revoking twice is harmless, but only revoke a distinct second URL.
    if (c.originalUrl && c.originalUrl !== c.previewUrl) URL.revokeObjectURL(c.originalUrl)
  }
}

/**
 * A one-line summary of what was found, for the panel header.
 *
 * States the count of images that carry a panel separately from the total,
 * because those are the ones where something is being changed on the
 * designer's behalf.
 */
export function summariseImport(result: ImportResult): string {
  const usable = result.candidates.filter((c) => c.file)
  const cropped = usable.filter((c) => c.panel?.hasPanel)
  const failed = result.candidates.filter((c) => !c.file)
  const bits: string[] = []
  bits.push(`${usable.length} image${usable.length === 1 ? '' : 's'}`)
  if (cropped.length > 0) bits.push(`${cropped.length} with the price panel removed`)
  if (failed.length > 0) bits.push(`${failed.length} that could not be read`)
  return bits.join(' · ')
}
