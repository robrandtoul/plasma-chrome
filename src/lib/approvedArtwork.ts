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

import JSZip from 'jszip'
import { supabase } from './supabase'
import { downloadBlob } from './downloadFile'

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

// Fetch the approved artwork for a proof. Returns null if it has no current
// version (shouldn't happen for an ordered proof). files is [] when the current
// version carries no non-QR images.
export async function fetchApprovedArtwork(proofId: string): Promise<ApprovedArtwork | null> {
  const [{ data: proofRow }, { data: versionRows }] = await Promise.all([
    supabase.from('proofs').select('approved_at').eq('id', proofId).maybeSingle(),
    supabase
      .from('proof_versions')
      .select('id, version_number, is_current, shape')
      .eq('proof_id', proofId)
      .order('created_at', { ascending: false }),
  ])

  const versions = (versionRows ?? []) as {
    id: string
    version_number: number
    is_current: boolean
    shape: string | null
  }[]
  const current = versions.find((v) => v.is_current)
  if (!current) return null

  const { data: imageRows } = await supabase
    .from('proof_version_images')
    .select('id, image_path, original_filename, associated_name, side, layout_id')
    .eq('proof_version_id', current.id)
    .eq('is_qr_code', false)
  const images = (imageRows ?? []) as {
    id: string
    image_path: string
    original_filename: string | null
    associated_name: string | null
    side: 'front' | 'back' | null
    layout_id: string | null
  }[]

  // Set (collection) images fold by layout title, not recipient name.
  const isCollection = current.shape === 'set_collection'
  const layoutTitles = new Map<string, string>()
  if (isCollection) {
    const { data: layoutRows } = await supabase
      .from('proof_layouts')
      .select('id, title')
      .eq('proof_version_id', current.id)
    for (const l of (layoutRows ?? []) as { id: string; title: string }[]) layoutTitles.set(l.id, l.title)
  }

  const files = sortFiles(
    images.map((r) => ({
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

  return {
    files,
    approvedAt: (proofRow as { approved_at?: string | null } | null)?.approved_at ?? null,
    isOneSided: !files.some((f) => f.side === 'back'),
    isAllShared: !isCollection && files.every((f) => f.associatedName == null),
    isCollection,
  }
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
  const { files, isAllShared, isOneSided, isCollection, approvedAt } = artwork
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
  const header =
    `Project: ${meta.projectName}\n` +
    `Customer: ${meta.customerName}\n` +
    `Approved: ${approvedDate}\n` +
    `Material: ${meta.materialDisplay ?? '—'}\n\n`

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
