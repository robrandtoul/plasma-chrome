import { supabase } from './supabase'

// Safely remove proof-image storage objects. Shape B (commit that
// shipped this file) introduced path-sharing across versions: a v2
// created via carry-forward references the same storage object as
// its v1 counterpart via the same image_path. That means a blind
// storage.remove() after deleting one version's row can nuke
// another version's still-referenced image.
//
// This helper queries proof_version_images for any other row that
// still references each candidate path. Only paths with no
// remaining references are actually removed from storage.
//
// Use this instead of `supabase.storage.from('proof-images').remove(paths)`
// anywhere a version's rows are being deleted while other versions
// might survive. Project-wide deletion (every version going at
// once) can still use a direct storage.remove() — no references
// survive the cascade. Upload-failure rollback paths can too —
// those paths haven't been linked anywhere yet.
export async function safeRemoveImagePaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return

  // Dedupe the input in case a caller passes the same path twice
  // (e.g. if an image was accidentally saved against two rows in
  // the same version — unusual but harmless here).
  const unique = [...new Set(paths)]

  // Find every proof_version_images row still referencing any of
  // these paths. Callers typically invoke this AFTER deleting the
  // rows they want to drop, so any survivor in this query is by
  // definition another version's reference to a shared path.
  const { data: survivors } = await supabase
    .from('proof_version_images')
    .select('image_path')
    .in('image_path', unique)

  const referenced = new Set((survivors ?? []).map((r) => r.image_path as string))
  const removable = unique.filter((p) => !referenced.has(p))

  if (removable.length > 0) {
    await supabase.storage.from('proof-images').remove(removable)
  }
}
