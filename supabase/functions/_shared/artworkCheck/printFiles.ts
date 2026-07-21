// Print-file selection from the order's Dropbox folder listing. The check
// reads the files that actually PRINT — metal jobs are native .ai (valid
// PDF-1.6 internally), plastic/full-colour jobs export as .pdf. The proof
// JPEGs alongside are NOT a substitute (observed to lag the print file by
// days), so only .pdf/.ai are candidates. Everything else is skipped with a
// reason so the report can say what wasn't read.

export interface FolderEntry {
  name: string
  is_folder: boolean
  path: string
  size: number
}

export interface PrintFilePick {
  name: string
  path: string
  size: number
}

// Anthropic caps a request at ~32 MB and a document block at 100 pages; print
// files are single-page and usually 0.5–3 MB, so these caps only bite on
// outliers. Base64 expands bytes 4/3 — 6 files × 4 MB raw ≈ 32 MB encoded is
// already the ceiling, hence the conservative totals.
export const PRINT_FILE_MAX_BYTES = 8 * 1024 * 1024
export const PRINT_FILES_MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const PRINT_FILES_MAX_COUNT = 8

export function pickPrintFiles(
  entries: FolderEntry[],
): { files: PrintFilePick[]; skipped: { name: string; reason: string }[] } {
  const files: PrintFilePick[] = []
  const skipped: { name: string; reason: string }[] = []
  let total = 0
  // Name order so "01_Front / 02_Back / 03_…" reads in sequence; stable across
  // runs regardless of Dropbox listing order.
  const ordered = entries
    .filter((e) => !e.is_folder)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const e of ordered) {
    const lower = e.name.toLowerCase()
    if (!/\.(pdf|ai)$/.test(lower)) {
      // Only worth reporting the near-misses: .eps is print artwork we can't
      // send (raw PostScript, not PDF-compatible); previews and everything
      // else are silently irrelevant.
      if (/\.eps$/.test(lower)) skipped.push({ name: e.name, reason: 'EPS — not PDF-readable' })
      continue
    }
    if (e.size > PRINT_FILE_MAX_BYTES) {
      skipped.push({ name: e.name, reason: 'over the size limit for checking' })
      continue
    }
    if (files.length >= PRINT_FILES_MAX_COUNT) {
      skipped.push({ name: e.name, reason: 'file limit reached' })
      continue
    }
    if (total + e.size > PRINT_FILES_MAX_TOTAL_BYTES) {
      skipped.push({ name: e.name, reason: 'total size limit reached' })
      continue
    }
    files.push({ name: e.name, path: e.path, size: e.size })
    total += e.size
  }
  return { files, skipped }
}

// .ai files are only sendable when they really are PDF-flavoured (every modern
// Illustrator save is; ancient ones aren't). Sniff the magic bytes before
// spending a document block on it.
export function looksLikePdf(bytes: Uint8Array): boolean {
  // %PDF
  return bytes.length >= 4 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

// Cut-through construction: artwork cut through the material from the front is
// necessarily mirrored on the back — expected on every cut-through material,
// never a flag. Gated on the version's material code (spec allow-list).
export function isCutThroughMaterial(code: string | null | undefined): boolean {
  if (!code) return false
  return code.startsWith('metal_') || code === 'acrylic' || code === 'wood' ||
    code === 'carbon_fibre' || code === 'carbon_fibre_cnc'
}
