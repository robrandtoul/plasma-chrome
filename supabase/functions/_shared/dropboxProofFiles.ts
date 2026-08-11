// Work out which files in a Dropbox order folder are the proofs, and how to
// reach a folder the designer has pasted.
//
// Plasma's order folders go back to 2014 and the naming has drifted the whole
// way, so this is deliberately a SHORTLIST rather than an answer: the designer
// confirms which images belong in the new proof. What matters here is that
// nothing is dropped silently — every file left out is returned with the reason,
// because "we found 3 proofs" reads as complete whether it is or not.
//
// Pure and dependency-free so it can be tested without a network. Lives in
// _shared because the edge function does the selecting: the browser only ever
// receives the shortlist plus the reasons, never the raw folder.

/** One entry as Dropbox reports it. */
export interface DropboxEntry {
  name: string
  /** Path relative to the folder root, e.g. "/JPGs/Proof02_Name.jpg". */
  path: string
  is_folder: boolean
  size?: number
}

export interface PickedFile extends DropboxEntry {
  /** Why this one made the shortlist — shown to the designer. */
  why: string
}

export interface SkippedFile {
  name: string
  reason: string
}

export interface ProofFileSelection {
  chosen: PickedFile[]
  skipped: SkippedFile[]
  /**
   * How the shortlist was arrived at, in plain English, for the UI to show
   * above the contact sheet. The designer needs to know whether they are
   * looking at "the Proof files" or "everything we found", because the second
   * needs much more care.
   */
  basis: string
}

const IMAGE_RE = /\.(jpe?g|png)$/i
// Everything an order folder holds that is not a proof to show a customer.
// Print files and the workshop note are the bulk of it.
const NON_IMAGE_NOTE: Record<string, string> = {
  ai: 'Illustrator print file',
  pdf: 'print file',
  rtf: 'workshop note',
  psd: 'Photoshop working file',
  eps: 'print file',
  zip: 'archive',
  doc: 'document',
  docx: 'document',
  txt: 'note',
}

/**
 * Cap on how many images are offered at once.
 *
 * A 40-recipient job really does hold 80+ proof images, and fetching and
 * cropping every one before the designer has looked at anything is a lot of
 * work for a page that may be closed immediately. The cap is REPORTED rather
 * than silently applied — a truncated list that looks complete is the failure
 * mode worth avoiding.
 */
export const MAX_PROOF_FILES = 40

function extension(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * Shortlist the proof images in an order folder.
 *
 * Three narrowing steps, each applied only if it leaves anything:
 *   1. images only
 *   2. those inside a JPGs folder, if there is one — the house convention
 *   3. those named Proof*, if any are — also the house convention
 *
 * ⚠ Steps 2 and 3 must BOTH be able to fail open, and that is the whole reason
 * they are written this way. The Proof* convention does not exist in the oldest
 * archive at all: a recursive listing of 2008 found 0 of 207 JPEGs matching it
 * across 144 order folders. A filter that returned nothing there would report an
 * empty folder — telling the designer there is no artwork when the folder is
 * full of it — so when a convention finds nothing, everything is offered
 * instead and `basis` says so.
 */
export function selectProofImages(entries: DropboxEntry[]): ProofFileSelection {
  const skipped: SkippedFile[] = []
  const files = entries.filter((e) => !e.is_folder)

  const images: DropboxEntry[] = []
  for (const f of files) {
    if (IMAGE_RE.test(f.name)) {
      images.push(f)
      continue
    }
    const ext = extension(f.name)
    skipped.push({ name: f.name, reason: NON_IMAGE_NOTE[ext] ?? (ext ? `.${ext} file` : 'not an image') })
  }

  if (images.length === 0) {
    return { chosen: [], skipped, basis: 'No images in that folder.' }
  }

  // 2. Prefer a JPGs subfolder when the folder has one.
  const inJpgs = images.filter((f) => segments(f.path).slice(0, -1).some((s) => /^jpe?gs?$/i.test(s)))
  const afterFolder = inJpgs.length > 0 ? inJpgs : images
  const usedJpgs = inJpgs.length > 0
  if (usedJpgs) {
    for (const f of images) {
      if (!inJpgs.includes(f)) skipped.push({ name: f.name, reason: 'outside the JPGs folder' })
    }
  }

  // 3. Prefer files named Proof*.
  const named = afterFolder.filter((f) => /^proof/i.test(f.name))
  const usedNaming = named.length > 0
  const shortlist = usedNaming ? named : afterFolder
  if (usedNaming) {
    for (const f of afterFolder) {
      if (!named.includes(f)) skipped.push({ name: f.name, reason: 'not named Proof…' })
    }
  }

  // Stable order: by path, so the same folder always presents the same way.
  const sorted = [...shortlist].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const capped = sorted.slice(0, MAX_PROOF_FILES)
  for (const f of sorted.slice(MAX_PROOF_FILES)) {
    skipped.push({ name: f.name, reason: `over the ${MAX_PROOF_FILES}-image limit` })
  }

  const why = usedNaming ? 'named Proof…' : usedJpgs ? 'in the JPGs folder' : 'an image in this folder'
  const chosen: PickedFile[] = capped.map((f) => ({ ...f, why }))

  const basis = usedNaming
    ? `Showing the ${chosen.length} file${chosen.length === 1 ? '' : 's'} named “Proof…”${usedJpgs ? ' in the JPGs folder' : ''}.`
    : usedJpgs
      ? `No files are named “Proof…”, so showing all ${chosen.length} image${chosen.length === 1 ? '' : 's'} in the JPGs folder — check these carefully.`
      : `This folder does not use the usual naming, so showing all ${chosen.length} image${chosen.length === 1 ? '' : 's'} it holds — check these carefully.`

  return { chosen, skipped, basis }
}

// ── Reaching the folder ─────────────────────────────────────────────────────

export type FolderInput =
  | { kind: 'shared'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'name'; name: string }

/**
 * Work out how to reach whatever the designer pasted.
 *
 * Three shapes, because there are three ways a folder legitimately arrives:
 *
 *  · a SHARED LINK, which is what the Orders page already deals in. Recent
 *    order folders have one.
 *  · a PATH from the Dropbox web address bar. This is the important one for
 *    this feature: archived order folders have never been shared, and creating
 *    a link for one would publish a decade of customers' artwork on permanent
 *    public URLs. Reading by path needs no link and publishes nothing.
 *  · a bare FOLDER NAME, as a last resort — "Order 38294 - Norwood" typed or
 *    pasted from somewhere else. Resolved by searching, since a name says
 *    nothing about where the folder sits.
 *
 * Returns null when the input is empty or unrecognisable, so the caller can say
 * so rather than issuing a request that will fail obscurely.
 */
export function parseFolderInput(raw: string): FolderInput | null {
  const input = (raw ?? '').trim()
  if (!input) return null

  // A shared link: /s/ or /scl/fo/ on a dropbox host.
  if (/^https?:\/\/(www\.)?dropbox\.com\/(s\/|scl\/)/i.test(input)) {
    return { kind: 'shared', url: input }
  }

  // A web-app address: .../home/<path> or .../work/<path>. The path is
  // percent-encoded and may carry a query string.
  const web = input.match(/^https?:\/\/(?:www\.)?dropbox\.com\/(?:home|work)((?:\/[^?#]*)?)/i)
  if (web) {
    const path = decodeURIComponent(web[1] ?? '').replace(/\/+$/, '')
    return path ? { kind: 'path', path } : null
  }

  // Any other dropbox.com URL is a shape we have not seen; guessing at it would
  // produce a confusing failure deeper in.
  if (/^https?:\/\//i.test(input)) {
    return /dropbox\.com/i.test(input) ? { kind: 'shared', url: input } : null
  }

  // A plain path.
  if (input.startsWith('/')) return { kind: 'path', path: input.replace(/\/+$/, '') }

  // Otherwise treat it as a folder name to search for.
  return { kind: 'name', name: input }
}
