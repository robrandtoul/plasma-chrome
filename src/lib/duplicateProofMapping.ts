// Pure field-mapping for project duplication (duplicateProof.ts). Kept free
// of supabase/env imports so the unit tests (duplicateProof.test.ts) can run
// under tsx without a Vite environment — same split as the other tested libs.

// ── Source row shapes (only the fields the copy touches) ──────────────────

export interface SourceVersion {
  id: string
  material_id: string | null
  material_display: string
  ink_names: string[] | null
  currency: string | null
  displayed_variant_ids: string[] | null
  material_options: string[] | null
  custom_quote: boolean
  names: string[] | null
  card_type: string | null
  shape: string | null
  is_variant_round: boolean
  is_per_direction_pricing: boolean
  has_personalisation: boolean
  team_sharing_enabled: boolean
  front_colour_id: string | null
  core_colour_id: string | null
  back_colour_id: string | null
  shipping_note: string | null
}

// One approved slot on the source's current version, as carried onto a
// reorder's v1. Only the fields the copy touches.
export interface SourceApproval {
  /** The slot key: a recipient name, '__shared__', or a LAYOUT ID. */
  name: string
  /** NOT NULL with no default — omitting it is a 23502, not a silent null. */
  actor_name: string
  qr_confirmed_at: string | null
  qr_snapshot: unknown | null
}

export interface SourceImage {
  image_path: string
  sort_order: number
  material_option: string | null
  original_filename: string | null
  associated_name: string | null
  side: string | null
  round_variant_id: string | null
  layout_id: string | null
  is_qr_code: boolean
  qr_decoded_data: string | null
  qr_kind: string | null
  qr_vcard_slug: string | null
}

// New storage path for a copied image. Same `${proofId}/${uuid}.{ext}`
// convention as the version forms; the extension follows the source file
// (jpg for artwork, png for scanner-found QRs, svg for hosted-vCard QRs)
// so downstream tooling that inspects suffixes keeps working.
export function duplicateImagePath(newProofId: string, sourcePath: string, uuid: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(sourcePath)
  const ext = m ? m[1].toLowerCase() : 'jpg'
  return `${newProofId}/${uuid}.${ext}`
}

// The proof_versions insert for the duplicate's v1. version_number and
// is_current are assigned by DB triggers; the split-name surcharge trigger
// re-stamps at today's rates on insert.
export function duplicateVersionInsert(source: SourceVersion, newProofId: string) {
  return {
    proof_id: newProofId,
    material_id: source.material_id,
    material_display: source.material_display,
    ink_names: source.ink_names ?? [],
    currency: source.currency,
    displayed_variant_ids: source.displayed_variant_ids ?? [],
    // Change notes describe the previous version's delta — meaningless on a
    // fresh project's v1, so the duplicate starts without any.
    change_notes: null,
    material_options: source.material_options ?? [],
    custom_quote: source.custom_quote,
    names: source.names ?? [],
    card_type: source.card_type,
    // Explicit clone lineage (same column the carry-forward path stamps).
    cloned_from_version_id: source.id,
    front_colour_id: source.front_colour_id,
    core_colour_id: source.core_colour_id,
    back_colour_id: source.back_colour_id,
    is_variant_round: source.is_variant_round,
    is_per_direction_pricing: source.is_per_direction_pricing,
    has_personalisation: source.has_personalisation,
    team_sharing_enabled: source.team_sharing_enabled,
    shape: source.shape,
    shipping_note: source.shipping_note,
  }
}

// One proof_version_images insert. round_variant_id / layout_id are remapped
// through the freshly-inserted children; an id the map doesn't know (which
// would mean the source row pointed at another version's child — corrupt
// data) degrades to null rather than inserting a dangling reference.
export function duplicateImageInsert(
  img: SourceImage,
  newVersionId: string,
  newPath: string,
  variantIdMap: Map<string, string>,
  layoutIdMap: Map<string, string>,
) {
  return {
    proof_version_id: newVersionId,
    image_path: newPath,
    sort_order: img.sort_order,
    material_option: img.material_option,
    original_filename: img.original_filename,
    associated_name: img.associated_name,
    side: img.side ?? 'front',
    round_variant_id: img.round_variant_id ? variantIdMap.get(img.round_variant_id) ?? null : null,
    layout_id: img.layout_id ? layoutIdMap.get(img.layout_id) ?? null : null,
    is_qr_code: img.is_qr_code,
    qr_decoded_data: img.qr_decoded_data,
    qr_kind: img.qr_kind,
    qr_vcard_slug: img.qr_vcard_slug,
  }
}

// A slot key that is a uuid is a LAYOUT ID (the Set-collection shape keys its
// approval rows on proof_layouts.id, not on a person's name). Recipient names
// and '__shared__' are never uuids, so this is a safe discriminator.
const LAYOUT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One proof_name_approvals insert, carrying an approved slot from the source
// proof's current version onto the reorder's v1.
//
// ⚠ carried_from_version_id is load-bearing in two ways, and both matter:
//
//   1. It is the truth. These rows are a carry-forward of a sign-off the
//      customer gave on ANOTHER project, not a fresh approval. Nothing at the
//      database layer would stop us fabricating one — the insert policy has no
//      attribution check at all — so the honesty has to come from here.
//   2. It suppresses the finaliser. The live trigger is
//      `WHEN (new.state = 'approved' AND new.carried_from_version_id IS NULL)`,
//      so a non-null value means maybe_finalize_proof_status() never runs and
//      proofs.status is left entirely to the caller. That is what we want:
//      duplicateProof sets status at INSERT time, and letting the trigger do it
//      instead would make an already-approved proof's approval CONTINGENT on
//      the slot-count and QR predicates passing — a QR-bearing or Set-collection
//      reorder could silently stay in_progress after the UI said otherwise.
//
// Returns null for a slot that cannot be honestly carried — see the layout
// remap below. Callers must filter.
export function duplicateApprovalInsert(
  approval: SourceApproval,
  newVersionId: string,
  sourceVersionId: string,
  layoutIdMap: Map<string, string>,
) {
  // Set-collection slots are keyed on layout id, and duplicateProof mints
  // FRESH layout ids — so carrying the source's key verbatim would produce a
  // row matching no image at all: an approved proof whose Approved-artwork
  // table and production ZIP come out empty, which is the exact failure this
  // whole feature exists to prevent. Remap, or drop the row and let the
  // caller notice the count is short.
  const mapped = layoutIdMap.get(approval.name)
  const slot = mapped ?? (LAYOUT_KEY_RE.test(approval.name) ? null : approval.name)
  if (slot === null) return null

  return {
    proof_version_id: newVersionId,
    name: slot,
    state: 'approved',
    // The human who actually signed off, kept as-is. Attribution belongs to
    // them; the fact it was carried is recorded by carried_from_version_id.
    actor_name: approval.actor_name,
    carried_from_version_id: sourceVersionId,
    // Carried so a later version of the REORDER can itself carry them
    // forward. The duplicate copies the QR image rows verbatim, so the QR
    // payload set is identical by construction and the confirmation still
    // describes what the customer actually checked.
    qr_confirmed_at: approval.qr_confirmed_at,
    qr_snapshot: approval.qr_snapshot,
    // id / created_at / updated_at all have defaults.
    // material_option_code is deliberately left null: a BEFORE trigger
    // validates it against the version's material_options and raises 23514 on
    // a mismatch, and every carried row on live leaves it null.
  }
}
