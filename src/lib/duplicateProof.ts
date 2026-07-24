// Duplicate a project — the one-click repeat-order path.
//
// A customer who received their cards and wants more shouldn't force the
// designer to rebuild the project from scratch. duplicateProof() creates a
// NEW proof for the same contact whose v1 is a faithful copy of the source
// proof's current version: material, names, ink colours, letterpress
// colours, option tabs, every image (artwork + QR codes) and, for the
// structured shapes, the round variants / layouts the images hang off.
//
// What deliberately does NOT come across:
//   * approvals, views, events, orders, reminders — the new proof starts
//     open (in_progress) and earns its own approval;
//   * the Help Scout link — a reorder usually arrives on a new conversation,
//     so the proof is created with an override reason and the designer links
//     the real thread from the detail page;
//   * pricing — the customer page reads live price tiers, and the DB trigger
//     re-stamps the split-name tooling surcharge on insert, so the duplicate
//     quotes today's price list, not the one from the original order;
//   * change notes — those described a delta between the source's versions.
//
// Storage objects are COPIED, not path-shared. Path-sharing is the carry-
// forward convention WITHIN one proof (see imageStorage.ts), but a whole-
// project delete removes storage files directly, so a cross-proof shared
// path would let deleting the old project break the new one.

import { supabase } from './supabase'
import { v4 as uuidv4 } from 'uuid'
import { logAudit } from './audit'
import {
  duplicateImagePath,
  duplicateImageInsert,
  duplicateVersionInsert,
  type SourceImage,
  type SourceVersion,
} from './duplicateProofMapping'

// Creates the duplicate and returns the new proof's id. Throws a
// designer-readable Error on failure; everything created up to that point
// is rolled back (proof delete cascades the version/children/image rows,
// then the copied storage objects are removed).
export async function duplicateProof(sourceProofId: string, userId: string): Promise<string> {
  // 1. Load the source proof + its current version + children + images.
  const { data: sourceProof, error: proofErr } = await supabase
    .from('proofs')
    .select('id, contact_id, contacts(full_name)')
    .eq('id', sourceProofId)
    .single()
  if (proofErr || !sourceProof) {
    throw new Error(`Couldn't load this project: ${proofErr?.message ?? 'not found'}`)
  }

  const { data: sourceVersion, error: versionErr } = await supabase
    .from('proof_versions')
    .select(
      'id, material_id, material_display, ink_names, currency, displayed_variant_ids, material_options, custom_quote, names, card_type, shape, is_variant_round, is_per_direction_pricing, has_personalisation, team_sharing_enabled, front_colour_id, core_colour_id, back_colour_id, shipping_note',
    )
    .eq('proof_id', sourceProofId)
    .eq('is_current', true)
    .maybeSingle()
  if (versionErr || !sourceVersion) {
    throw new Error(
      `Couldn't load the current version: ${versionErr?.message ?? 'this project has no version to copy'}`,
    )
  }
  const src = sourceVersion as unknown as SourceVersion

  const [variantsResult, layoutsResult, imagesResult] = await Promise.all([
    supabase
      .from('proof_round_variants')
      .select('id, code, display_name, sort_order')
      .eq('proof_version_id', src.id)
      .order('sort_order'),
    supabase
      .from('proof_layouts')
      .select('id, title, sort_order')
      .eq('proof_version_id', src.id)
      .order('sort_order'),
    supabase
      .from('proof_version_images')
      .select(
        'image_path, sort_order, material_option, original_filename, associated_name, side, round_variant_id, layout_id, is_qr_code, qr_decoded_data, qr_kind, qr_vcard_slug',
      )
      .eq('proof_version_id', src.id)
      .order('sort_order'),
  ])
  const childErr = variantsResult.error ?? layoutsResult.error ?? imagesResult.error
  if (childErr) throw new Error(`Couldn't load the design to copy: ${childErr.message}`)

  const sourceVariants = (variantsResult.data ?? []) as Array<{ id: string; code: string; display_name: string; sort_order: number }>
  const sourceLayouts = (layoutsResult.data ?? []) as Array<{ id: string; title: string; sort_order: number }>
  const sourceImages = (imagesResult.data ?? []) as SourceImage[]

  // 2. Create the new proof shell. The proofs CHECK requires a Help Scout
  // link or an override reason; the reorder conversation doesn't exist as a
  // link on this proof yet, so we record why and the designer attaches the
  // real thread from the detail page.
  const { data: newProof, error: insertProofErr } = await supabase
    .from('proofs')
    .insert({
      contact_id: sourceProof.contact_id,
      created_by: userId,
      helpscout_override_reason: 'Duplicated from a previous project — link the new conversation when it arrives.',
      internal_notes: `Duplicated from a previous project: ${window.location.origin}/proofs/${sourceProofId}`,
    })
    .select('id')
    .single()
  if (insertProofErr || !newProof) {
    throw new Error(`Couldn't create the new project: ${insertProofErr?.message ?? 'unknown error'}`)
  }
  const newProofId = newProof.id as string

  const copiedPaths: string[] = []
  const rollBack = async () => {
    // Proof delete cascades the version, children and image rows. Direct
    // storage remove is safe here: the copied paths are fresh uuids that
    // nothing else references (same rule as the forms' upload rollback).
    await supabase.from('proofs').delete().eq('id', newProofId)
    if (copiedPaths.length > 0) {
      await supabase.storage.from('proof-images').remove(copiedPaths)
    }
  }

  try {
    // 3. Insert v1. Triggers assign version_number 1 + is_current.
    const { data: newVersion, error: insertVersionErr } = await supabase
      .from('proof_versions')
      .insert(duplicateVersionInsert(src, newProofId))
      .select('id')
      .single()
    if (insertVersionErr || !newVersion) {
      throw new Error(`Couldn't copy the version: ${insertVersionErr?.message ?? 'unknown error'}`)
    }
    const newVersionId = newVersion.id as string

    // 4. Copy the structural children and map old id → new id so the image
    // rows land against the right variant / layout.
    const variantIdMap = new Map<string, string>()
    if (sourceVariants.length > 0) {
      const { data: inserted, error } = await supabase
        .from('proof_round_variants')
        .insert(
          sourceVariants.map((v) => ({
            proof_version_id: newVersionId,
            code: v.code,
            display_name: v.display_name,
            sort_order: v.sort_order,
          })),
        )
        .select('id, sort_order')
      if (error || !inserted) throw new Error(`Couldn't copy the design directions: ${error?.message ?? 'unknown error'}`)
      const bySort = new Map(inserted.map((r) => [r.sort_order as number, r.id as string]))
      for (const v of sourceVariants) {
        const newId = bySort.get(v.sort_order)
        if (newId) variantIdMap.set(v.id, newId)
      }
    }

    const layoutIdMap = new Map<string, string>()
    if (sourceLayouts.length > 0) {
      const { data: inserted, error } = await supabase
        .from('proof_layouts')
        .insert(
          sourceLayouts.map((l) => ({
            proof_version_id: newVersionId,
            title: l.title,
            sort_order: l.sort_order,
          })),
        )
        .select('id, sort_order')
      if (error || !inserted) throw new Error(`Couldn't copy the layouts: ${error?.message ?? 'unknown error'}`)
      const bySort = new Map(inserted.map((r) => [r.sort_order as number, r.id as string]))
      for (const l of sourceLayouts) {
        const newId = bySort.get(l.sort_order)
        if (newId) layoutIdMap.set(l.id, newId)
      }
    }

    // 5. Copy every storage object to a fresh path under the new proof.
    const copyPlan = sourceImages.map((img) => ({
      img,
      newPath: duplicateImagePath(newProofId, img.image_path, uuidv4()),
    }))
    const copyResults = await Promise.all(
      copyPlan.map(async ({ img, newPath }) => {
        const { error } = await supabase.storage.from('proof-images').copy(img.image_path, newPath)
        if (!error) copiedPaths.push(newPath)
        return { error, source: img.image_path }
      }),
    )
    const failedCopy = copyResults.find((r) => r.error)
    if (failedCopy) {
      throw new Error(`Couldn't copy an image (${failedCopy.source}): ${failedCopy.error!.message}`)
    }

    // 6. Insert the image rows, sort order preserved.
    if (copyPlan.length > 0) {
      const { error: imgErr } = await supabase
        .from('proof_version_images')
        .insert(copyPlan.map(({ img, newPath }) => duplicateImageInsert(img, newVersionId, newPath, variantIdMap, layoutIdMap)))
      if (imgErr) throw new Error(`Couldn't copy the images: ${imgErr.message}`)
    }
  } catch (err) {
    try {
      await rollBack()
    } catch (cleanupErr) {
      console.warn('[duplicateProof] rollback failed', cleanupErr)
    }
    throw err
  }

  const contactName = (sourceProof as { contacts?: { full_name?: string } | null }).contacts?.full_name ?? ''
  void logAudit({
    action: 'proof.created',
    targetType: 'proof',
    targetId: newProofId,
    targetLabel: contactName,
    metadata: { source: 'duplicate', duplicated_from_proof_id: sourceProofId, duplicated_from_version_id: src.id },
  })
  void logAudit({
    action: 'proof.duplicated',
    targetType: 'proof',
    targetId: sourceProofId,
    targetLabel: contactName,
    metadata: { new_proof_id: newProofId },
  })

  return newProofId
}
