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
//     ⚠ EXCEPT on the reorder path (options.raiseReorder), where the source's
//     approved slots ARE carried and the new proof is born approved. That is
//     the whole point of it: a customer asking for more of what they already
//     signed off should not be asked to sign it off again. Everything else on
//     this list still applies. See DuplicateOptions.
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
  duplicateApprovalInsert,
  duplicateImagePath,
  duplicateImageInsert,
  duplicateVersionInsert,
  type SourceApproval,
  type SourceImage,
  type SourceVersion,
} from './duplicateProofMapping'

export interface DuplicateOptions {
  /**
   * Raise this duplicate as the answer to a customer's reorder request
   * (migration 000372/000373). Three differences from a plain duplicate:
   * the source's approved slots are carried onto v1, the new proof is born
   * approved, and it points back at the source — which is what clears the
   * source's needs-attention flag and lights the forward link on the
   * customer's old page.
   */
  raiseReorder?: boolean
  /** The customer's own words, recorded on the new project. */
  requestNote?: string | null
  requestQuantity?: number | null
}

export interface DuplicateResult {
  proofId: string
  /**
   * How many approved slots came across. ZERO is a real outcome, not an
   * error — see the pre-approval rule in duplicateProof. The caller must
   * tell the designer, because a reorder that arrives OPEN when they
   * expected it pre-approved is exactly the kind of surprise that gets a
   * customer asked to approve their own artwork twice.
   */
  approvalsCarried: number
}

// Creates the duplicate and returns the new proof's id. Throws a
// designer-readable Error on failure; everything created up to that point
// is rolled back (proof delete cascades the version/children/image rows,
// then the copied storage objects are removed).
export async function duplicateProof(
  sourceProofId: string,
  userId: string,
  options: DuplicateOptions = {},
): Promise<DuplicateResult> {
  const raiseReorder = options.raiseReorder === true
  // 1. Load the source proof + its current version + children + images.
  const { data: sourceProof, error: proofErr } = await supabase
    .from('proofs')
    .select('id, contact_id, status, contacts(full_name)')
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

  // 1b. The reorder path only: the approved slots to carry, and the guard
  // against raising the same reorder twice.
  let sourceApprovals: SourceApproval[] = []
  if (raiseReorder) {
    // ⚠ Scoped to the source's CURRENT version, which is what the query above
    // already selected. Approval rows exist on superseded versions too, and
    // copying those would resurrect a sign-off the customer replaced — the
    // exact shape the approved_earlier_version rule exists to flag.
    const { data: approvalRows, error: approvalErr } = await supabase
      .from('proof_name_approvals')
      .select('name, actor_name, qr_confirmed_at, qr_snapshot')
      .eq('proof_version_id', src.id)
      .eq('state', 'approved')
    if (approvalErr) {
      throw new Error(`Couldn't read the approvals to carry over: ${approvalErr.message}`)
    }
    sourceApprovals = (approvalRows ?? []) as unknown as SourceApproval[]

    // Already raised? The needs-attention rule clears on the bare EXISTENCE of
    // a child, so a second click would build a whole second project while the
    // flag stayed cleared by the first — two live reorders for one request,
    // and nothing on the dashboard to say so. Cheap read, checked late enough
    // to catch a colleague who clicked while this dialog was open.
    const { data: existing, error: existingErr } = await supabase
      .from('proofs')
      .select('id')
      .eq('reorder_of_proof_id', sourceProofId)
      .limit(1)
      .maybeSingle()
    if (existingErr) {
      throw new Error(`Couldn't check for an existing reorder: ${existingErr.message}`)
    }
    if (existing) {
      throw new Error(
        'A reorder has already been raised from this project. Open it from the "Customer reorder" link rather than raising a second one.',
      )
    }
  }

  // Pre-approve ONLY when the source is approved AND there is something to
  // carry. Both halves are load-bearing, for different reasons.
  //
  // `sourceApprovals.length > 0` — a proof can be `approved` with no approval
  // rows at all: a designer used "Mark as approved", or it is a variant round,
  // whose slots the finaliser deliberately bails on (000141). Flipping the
  // reorder to approved there produces the state this feature exists to avoid,
  // a project that reads Approved everywhere while its Approved-artwork table
  // and production ZIP are empty.
  //
  // ⚠ `sourceProof.status === 'approved'` — the subtler half, and the one that
  // protects PRODUCTION. src/lib/approvedArtwork.ts (the order-side hand-off)
  // takes the current version's non-QR images WHOLESALE, and says why in its
  // header: "a proof reaches 'approved' only once every required slot of the
  // CURRENT version is signed off". Every other route to approved upholds that
  // — the finaliser requires a complete set, and handleApprove writes a row for
  // every missing slot. This path would be the first that could not, because
  // carried rows deliberately suppress the finaliser: reopen a source (which
  // deletes all its approvals, 000158), re-approve only Ada on the new version,
  // and a partial carry would mint a fully-approved child whose production ZIP
  // contains Kelly's unapproved card. Requiring the source to be approved
  // restores the invariant, since on this codebase "approved AND at least one
  // row" IS "complete slot set".
  //
  // Neither case is an error. The reorder is created OPEN and the designer is
  // told, which is the honest outcome — a project that needs approving is
  // recoverable, a lie about what production may print is not.
  const preApprove =
    raiseReorder && sourceProof.status === 'approved' && sourceApprovals.length > 0

  // 2. Create the new proof shell. The proofs CHECK requires a Help Scout
  // link or an override reason; the reorder conversation doesn't exist as a
  // link on this proof yet, so we record why and the designer attaches the
  // real thread from the detail page.
  const sourceUrl = `${window.location.origin}/proofs/${sourceProofId}`
  const { data: newProof, error: insertProofErr } = await supabase
    .from('proofs')
    .insert({
      contact_id: sourceProof.contact_id,
      created_by: userId,
      helpscout_override_reason: raiseReorder
        ? 'Raised from a customer reorder request — link the reorder conversation when you pick it up.'
        : 'Duplicated from a previous project — link the new conversation when it arrives.',
      internal_notes: raiseReorder
        ? reorderNotes(sourceUrl, options.requestQuantity ?? null, options.requestNote ?? null)
        : `Duplicated from a previous project: ${sourceUrl}`,
      // ⚠ Set at INSERT, never by a follow-up UPDATE. proofs has no INSERT
      // trigger at all, but it does have `notify_push_on_proof_approved`
      // AFTER UPDATE OF status — so flipping it afterwards would push
      // "proof approved" to the whole team's phones for an approval the
      // customer never made on this project.
      ...(preApprove ? { status: 'approved', approved_at: new Date().toISOString() } : {}),
    })
    .select('id')
    .single()
  if (insertProofErr || !newProof) {
    throw new Error(`Couldn't create the new project: ${insertProofErr?.message ?? 'unknown error'}`)
  }
  const newProofId = newProof.id as string

  let approvalsCarried = 0
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

    // 7. Reorder path: carry the approved slots onto v1.
    //
    // ⚠ This THROWS on failure rather than warning. The carry-forward code in
    // NewVersionPage deliberately downgrades the same error to a console
    // warning, because there losing the carry is better than losing a saved
    // version. Here the trade is inverted: the proof has already been created
    // approved, so a swallowed failure lands a project that says Approved
    // with an empty artwork table and an empty ZIP — silently, since the page
    // renders only a quiet "No approved images found." card. Better to roll
    // the whole thing back and let the designer try again.
    if (preApprove) {
      const rows = sourceApprovals
        .map((a) => duplicateApprovalInsert(a, newVersionId, src.id, layoutIdMap))
        .filter((r): r is NonNullable<typeof r> => r !== null)
      if (rows.length !== sourceApprovals.length) {
        throw new Error(
          "Couldn't match every approved item to the copied design, so the reorder wasn't created. Duplicate the project instead and approve it as usual.",
        )
      }
      const { error: approvalInsertErr } = await supabase.from('proof_name_approvals').insert(rows)
      if (approvalInsertErr) {
        throw new Error(`Couldn't carry the approvals across: ${approvalInsertErr.message}`)
      }
      approvalsCarried = rows.length
    }

    // 8. Reorder path: point the new project back at the one it came from.
    //
    // ⚠ Deliberately the LAST write. This stamp is the commit point — the
    // needs-attention rule clears on the bare existence of a child row, with
    // no status or version filter, and it can never re-fire for this request.
    // Stamping it earlier would mean a crash between here and the end (closed
    // tab, dropped connection) clears the customer's request FOREVER against a
    // half-built project. Stamped last, the worst crash leaves an orphan
    // project with no back-pointer: visible, harmless, and the source stays
    // flagged so the designer simply tries again.
    if (raiseReorder) {
      const { error: linkErr } = await supabase
        .from('proofs')
        .update({ reorder_of_proof_id: sourceProofId })
        .eq('id', newProofId)
      if (linkErr) throw new Error(`Couldn't link the reorder to the original project: ${linkErr.message}`)
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
    metadata: {
      source: raiseReorder ? 'reorder' : 'duplicate',
      duplicated_from_proof_id: sourceProofId,
      duplicated_from_version_id: src.id,
      ...(raiseReorder ? { pre_approved: preApprove, approvals_carried: approvalsCarried } : {}),
    },
  })
  void logAudit({
    // Distinct action on the SOURCE, because "the customer asked and we
    // answered" is a different event from a designer copying a project, and
    // the audit log is where that distinction has to survive.
    action: raiseReorder ? 'proof.reorder_raised' : 'proof.duplicated',
    targetType: 'proof',
    targetId: sourceProofId,
    targetLabel: contactName,
    metadata: {
      new_proof_id: newProofId,
      ...(raiseReorder ? { pre_approved: preApprove, approvals_carried: approvalsCarried } : {}),
    },
  })

  return { proofId: newProofId, approvalsCarried }
}

// The customer's own ask, recorded where the designer picking the job up will
// see it. Their words are the routing decision — "same again" goes straight to
// a pay link, anything else needs a fresh proof round — so they belong on the
// project, not only in the Help Scout thread that opened separately.
function reorderNotes(sourceUrl: string, quantity: number | null, note: string | null): string {
  const lines = [`Raised from a customer reorder request. Original project: ${sourceUrl}`]
  if (quantity != null && quantity > 0) {
    lines.push(`They asked for ${quantity.toLocaleString('en-GB')}.`)
  }
  if (note && note.trim()) {
    lines.push(`They said: ${note.trim()}`)
  }
  return lines.join('\n')
}
