// Approved-artwork access for an APPROVED proof: list the files, download one,
// or download the whole set as a production hand-off ZIP.
//
// This mirrors the "Approved artwork" section on the proof detail page
// (ProofDetailPage.handleDownloadZip) but is deliberately simpler: it's only
// used where the proof is already approved (an order exists), and a proof
// reaches 'approved' only once every required slot of the CURRENT version is
// signed off (migrations 000126/000169/000212), copying each unchanged
// recipient's image forward. So the current version always holds the complete
// approved set — we can take its non-QR images wholesale without re-deriving
// per-slot approval, which the detail page needs because it also renders
// in-progress proofs.
//
// "Wholesale" across the approval SLOTS, though — not across the finish tabs.
// A version proofed in three metal finishes carries three images per side, and
// the order was bought against exactly one of them, so the set is narrowed to
// the ordered finish by approvedArtworkFinish.ts. Skipping that handed
// production the whole matrix (six files for a two-file order) with nothing
// saying which to ignore.

import JSZip from 'jszip'
import { supabase } from './supabase'
import { downloadBlob } from './downloadFile'
import {
  scopeToOrderedFinish,
  finishScopeIsUncertain,
  type FinishScopeOutcome,
} from './approvedArtworkFinish'

export interface ApprovedArtworkFile {
  imageId: string
  imagePath: string
  originalFilename: string | null
  side: 'front' | 'back' | null
  // Recipient name; null = shared artwork (or a collection, keyed by layout).
  associatedName: string | null
  layoutId: string | null
  layoutTitle: string | null
  versionNumber: number
}

export interface ApprovedArtwork {
  files: ApprovedArtworkFile[]
  approvedAt: string | null
  isOneSided: boolean
  isAllShared: boolean
  isCollection: boolean
  // The finish the files were narrowed to ("Natural"), or null when the
  // version offered no finish choice / the narrowing couldn't be made.
  finishLabel: string | null
  // How the narrowing went. `finishUncertain` is the render signal: the list
  // is the FULL matrix and the caller must say so rather than present it as
  // the ordered set.
  finishScope: FinishScopeOutcome
  finishUncertain: boolean
  // How many finish tabs the version carried — lets the caller word the
  // warning concretely ("this proof has 3 finishes").
  finishTabCount: number
}

const BUCKET = 'proof-images'

// The identity a file is filed under — the recipient name, the layout title
// (collections), or "Shared" when it isn't allocated to anyone.
function identityOf(f: ApprovedArtworkFile): string {
  if (f.layoutTitle) return f.layoutTitle
  return f.associatedName ?? 'Shared'
}

// Sort by identity → side (front before back) → filename, so the list and the
// ZIP read in the same, stable order.
function sortFiles(files: ApprovedArtworkFile[]): ApprovedArtworkFile[] {
  return [...files].sort((a, b) => {
    const ai = identityOf(a)
    const bi = identityOf(b)
    if (ai !== bi) return ai.localeCompare(bi)
    const as = a.side === 'back' ? 1 : 0
    const bs = b.side === 'back' ? 1 : 0
    if (as !== bs) return as - bs
    return (a.originalFilename ?? '').localeCompare(b.originalFilename ?? '')
  })
}

// How a batch load is getting on, for a caller that fetches many orders' files
// at once and hands each card its own result. A plain `ApprovedArtwork | null`
// can't carry this: null would have to mean both "still loading" and "this
// order genuinely has no approved files", and a card would announce the second
// while the first was still true.
export type ApprovedArtworkLoad =
  | { status: 'loading' }
  | { status: 'ready'; artwork: ApprovedArtwork | null }
  | { status: 'error' }

// One caller's worth of "which files were approved for THIS order?". Keyed by
// the caller's own id (an order id) rather than the proof id, because the
// finish narrowing is per ORDER: one proof can carry two orders bought in two
// different finishes, and each wants its own slice of the same image set.
export interface ApprovedArtworkRequest {
  key: string
  proofId: string
  /** The order's `material_option_id`. See fetchApprovedArtwork's note. */
  materialOptionId?: string | null
}

type VersionRow = {
  id: string
  proof_id: string
  version_number: number
  shape: string | null
  material_options: string[] | null
}

type ImageRow = {
  id: string
  proof_version_id: string
  image_path: string
  original_filename: string | null
  associated_name: string | null
  side: 'front' | 'back' | null
  layout_id: string | null
  material_option: string | null
}

// Fetch approved artwork for MANY orders in a fixed number of round trips
// (proofs + current versions + images, plus finish labels and layout titles
// only when something needs them) rather than the ~4 per proof a loop over
// fetchApprovedArtwork would cost. The Orders page shows an artwork line on
// every card in Place, so the per-card shape would have put dozens of requests
// on the page load — the same trap the thumbnails already avoid.
//
// Requests whose proof has no current version are simply absent from the map;
// the caller reads that as "nothing to show", exactly as the single-proof
// helper's null does.
export async function fetchApprovedArtworkBatch(
  requests: ApprovedArtworkRequest[],
): Promise<Map<string, ApprovedArtwork>> {
  const out = new Map<string, ApprovedArtwork>()
  const proofIds = Array.from(new Set(requests.map((r) => r.proofId).filter(Boolean)))
  if (proofIds.length === 0) return out

  const [{ data: proofRows }, { data: versionRows }] = await Promise.all([
    supabase.from('proofs').select('id, approved_at').in('id', proofIds),
    // One current version per proof by construction (`is_current` is the
    // single-current invariant every approval path upholds), so this replaces
    // the per-proof "fetch all versions, find the current one" read.
    supabase
      .from('proof_versions')
      .select('id, proof_id, version_number, shape, material_options')
      .in('proof_id', proofIds)
      .eq('is_current', true),
  ])

  const approvedAtByProof = new Map<string, string | null>(
    ((proofRows ?? []) as { id: string; approved_at: string | null }[]).map((p) => [p.id, p.approved_at]),
  )
  const versionByProof = new Map<string, VersionRow>()
  for (const v of (versionRows ?? []) as VersionRow[]) {
    if (!versionByProof.has(v.proof_id)) versionByProof.set(v.proof_id, v)
  }
  if (versionByProof.size === 0) return out

  const versionIds = Array.from(versionByProof.values(), (v) => v.id)
  // Finish labels are only worth fetching for orders whose version actually
  // carries tabs to narrow — same test the single-proof path applies.
  const optionIds = Array.from(new Set(
    requests
      .filter((r) => {
        const v = versionByProof.get(r.proofId)
        return !!r.materialOptionId && (v?.material_options?.length ?? 0) > 0
      })
      .map((r) => r.materialOptionId as string),
  ))
  const collectionVersionIds = Array.from(versionByProof.values())
    .filter((v) => v.shape === 'set_collection')
    .map((v) => v.id)

  const [{ data: imageRows }, { data: optionRows }, { data: layoutRows }] = await Promise.all([
    supabase
      .from('proof_version_images')
      .select('id, proof_version_id, image_path, original_filename, associated_name, side, layout_id, material_option')
      .in('proof_version_id', versionIds)
      .eq('is_qr_code', false),
    optionIds.length > 0
      ? supabase.from('material_options').select('id, code, display_name').in('id', optionIds)
      : Promise.resolve({ data: [] as unknown[] }),
    collectionVersionIds.length > 0
      ? supabase.from('proof_layouts').select('id, title, proof_version_id').in('proof_version_id', collectionVersionIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ])

  const imagesByVersion = new Map<string, ImageRow[]>()
  for (const r of (imageRows ?? []) as ImageRow[]) {
    const list = imagesByVersion.get(r.proof_version_id)
    if (list) list.push(r)
    else imagesByVersion.set(r.proof_version_id, [r])
  }
  const optionById = new Map<string, { code: string | null; display_name: string | null }>(
    ((optionRows ?? []) as { id: string; code: string | null; display_name: string | null }[])
      .map((o) => [o.id, { code: o.code, display_name: o.display_name }]),
  )
  const layoutTitles = new Map<string, string>()
  for (const l of (layoutRows ?? []) as { id: string; title: string }[]) layoutTitles.set(l.id, l.title)

  for (const req of requests) {
    const current = versionByProof.get(req.proofId)
    if (!current) continue

    const versionOptionCodes = Array.isArray(current.material_options) ? current.material_options : []
    const opt = req.materialOptionId ? optionById.get(req.materialOptionId) : undefined
    const finishCode = versionOptionCodes.length > 0 ? opt?.code ?? null : null
    const finishLabel = versionOptionCodes.length > 0 ? opt?.display_name ?? null : null

    const scope = scopeToOrderedFinish(imagesByVersion.get(current.id) ?? [], versionOptionCodes, finishCode)
    // Set (collection) images fold by layout title, not recipient name.
    const isCollection = current.shape === 'set_collection'

    const files = sortFiles(
      scope.images.map((r) => ({
        imageId: r.id,
        imagePath: r.image_path,
        originalFilename: r.original_filename,
        side: r.side,
        associatedName: r.associated_name,
        layoutId: r.layout_id,
        layoutTitle: r.layout_id ? layoutTitles.get(r.layout_id) ?? null : null,
        versionNumber: current.version_number,
      })),
    )

    out.set(req.key, {
      files,
      approvedAt: approvedAtByProof.get(req.proofId) ?? null,
      isOneSided: !files.some((f) => f.side === 'back'),
      isAllShared: !isCollection && files.every((f) => f.associatedName == null),
      isCollection,
      // Only claim a finish when it actually narrowed the set — on the two
      // uncertain outcomes the label would describe files that aren't all there.
      finishLabel: scope.outcome === 'scoped' ? finishLabel ?? finishCode : null,
      finishScope: scope.outcome,
      finishUncertain: finishScopeIsUncertain(scope.outcome),
      finishTabCount: versionOptionCodes.length,
    })
  }

  return out
}

// Fetch the approved artwork for a proof, narrowed to the finish the order was
// placed against. Returns null if it has no current version (shouldn't happen
// for an ordered proof). files is [] when the current version carries no non-QR
// images.
//
// `materialOptionId` is the order's `material_option_id` — the finish the
// customer chose at checkout (or the designer set in the builder). It's
// optional only so a caller can't fail to compile; omitting it on a
// finish-tabbed proof yields the full matrix flagged as uncertain, which the
// UI shows as a warning. Never pass null to mean "all finishes".
//
// One request through the batch loader rather than its own implementation, so
// the collapsed one-line summary and the expanded file list can never disagree
// about which files this order was approved on.
export async function fetchApprovedArtwork(
  proofId: string,
  opts: { materialOptionId?: string | null } = {},
): Promise<ApprovedArtwork | null> {
  const map = await fetchApprovedArtworkBatch([
    { key: proofId, proofId, materialOptionId: opts.materialOptionId ?? null },
  ])
  return map.get(proofId) ?? null
}

// Sign a storage path → blob (short expiry; the caller uses it immediately).
async function fetchBlob(imagePath: string): Promise<Blob> {
  const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUrl(imagePath, 60)
  if (error || !signed?.signedUrl) throw new Error(`Couldn't sign ${imagePath}: ${error?.message ?? 'no URL'}`)
  const resp = await fetch(signed.signedUrl)
  if (!resp.ok) throw new Error(`Download failed for ${imagePath}: HTTP ${resp.status}`)
  return resp.blob()
}

// The ZIP leaf / individual filename. Original preserved verbatim (production
// matches it to the source Illustrator file); a null falls back to a synthetic
// name so the download still works.
function leafName(f: ApprovedArtworkFile): string {
  return f.originalFilename ?? `unnamed-${f.imageId.slice(0, 8)}.jpg`
}

// Download a single approved file under its original filename.
export async function downloadApprovedFile(file: ApprovedArtworkFile): Promise<void> {
  const blob = await fetchBlob(file.imagePath)
  downloadBlob(blob, leafName(file))
}

// Build + download the whole approved set as a production hand-off ZIP: original
// filenames preserved, one folder per identity (recipient / layout) — or flat at
// the root when everything is shared — plus a manifest cross-referencing
// filename → recipient/side. Mirrors the detail page's ZIP so both hand-offs
// look identical to production.
export async function downloadApprovedArtworkZip(
  artwork: ApprovedArtwork,
  meta: { projectName: string; customerName: string; materialDisplay: string | null },
): Promise<void> {
  const { files, isAllShared, isOneSided, isCollection, approvedAt, finishLabel, finishUncertain, finishTabCount } = artwork
  if (files.length === 0) return

  // Bounded concurrency: keep 4 signed-URL fetches in flight at once.
  const MAX_PARALLEL = 4
  const blobs = new Array<Blob>(files.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < files.length) {
      const i = cursor++
      blobs[i] = await fetchBlob(files[i].imagePath)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, files.length) }, worker))

  const zip = new JSZip()
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const leaf = leafName(f)
    if (isAllShared) zip.file(leaf, blobs[i])
    else zip.file(`${identityOf(f)}/${leaf}`, blobs[i])
  }

  const approvedDate = approvedAt
    ? new Date(approvedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })
    : '—'
  // The finish line carries into production: the ZIP holds one finish's files,
  // and the manifest is the only thing travelling with them that says which.
  // When the narrowing couldn't be made the manifest says THAT instead, so a
  // full-matrix ZIP is never mistaken for the ordered set.
  // With a single tab the narrowing is a no-op — every image IS the ordered
  // finish — so an "unrecorded" caution there would be noise, not a warning.
  const finishLine = finishLabel
    ? `Finish: ${finishLabel}\n`
    : finishUncertain && finishTabCount > 1
      ? `Finish: NOT RECORDED — this ZIP holds all ${finishTabCount} proofed finishes. Confirm which was ordered before printing.\n`
      : ''
  const header =
    `Project: ${meta.projectName}\n` +
    `Customer: ${meta.customerName}\n` +
    `Approved: ${approvedDate}\n` +
    `Material: ${meta.materialDisplay ?? '—'}\n` +
    finishLine +
    `\n`

  const identityLabel = isCollection ? 'Layout' : 'Name'
  const columns: string[] = []
  if (!isAllShared) columns.push(identityLabel)
  if (!isOneSided) columns.push('Side')
  columns.push('Version', 'Filename')
  const lines = [columns.join('\t')]
  for (const f of files) {
    const row: string[] = []
    if (!isAllShared) row.push(identityOf(f))
    if (!isOneSided) row.push((f.side ?? 'front') === 'front' ? 'Front' : 'Back')
    row.push(`v${f.versionNumber}`, leafName(f))
    lines.push(row.join('\t'))
  }
  zip.file('manifest.txt', header + lines.join('\n') + '\n')

  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, `${meta.projectName} - Approved Artwork.zip`)
}

// The secondary line for a file row: identity · Side · vN, omitting the parts
// that add nothing (identity when all shared, side when one-sided).
export function fileRowMeta(
  f: ApprovedArtworkFile,
  opts: { isAllShared: boolean; isOneSided: boolean },
): string {
  const parts: string[] = []
  if (!opts.isAllShared) parts.push(identityOf(f))
  if (!opts.isOneSided) parts.push((f.side ?? 'front') === 'front' ? 'Front' : 'Back')
  parts.push(`v${f.versionNumber}`)
  return parts.join(' · ')
}
