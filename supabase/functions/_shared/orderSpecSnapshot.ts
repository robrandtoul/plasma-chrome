// orderSpecSnapshot — the single definition of the durable order spec snapshot
// (proofs.orders.order_spec_snapshot, migration 000264).
//
// An order's spec is otherwise read LIVE from the proof's current version +
// the live catalogue, so it drifts if the proof is revised or a material is
// renamed after the order. This freezes the spec as it was when the order was
// committed: material, variant, finish, ink names, letterpress colours, the
// quantity / per-person split, and the contact + company AS AT order time.
//
// Built in TWO places — create-order (at creation) and place-order (overwritten
// at placement, so it reflects the spec actually handed to production after any
// revision). Both call this one builder so the two writers can't produce
// different shapes. The admin_search_orders RPC reads it back with COALESCE over
// these exact key paths, so the shape here and the RPC's paths must stay in
// lockstep:
//   material.code / material.display_name
//   variant.display_name
//   finish.display_name
//   ink_names[]
//   letterpress.{front,core,back}
//   quantity
//   person_quantities[]
//   contact.email
//   company.name

export interface OrderSpecSnapshotInput {
  /** materials.code for the version's material (null = no single material:
   *  custom quote / mixed-material variant round). */
  materialCode: string | null
  materialDisplay: string | null
  /** material_variants.display_name for the order's chosen variant. */
  variantDisplay: string | null
  /** material_variants.variant_type — needed to resolve finish-from-variant
   *  (metal Brushed/Mirror live on the variant, not a material_option). */
  variantType: string | null
  /** material_options.display_name for the order's chosen finish option, or null. */
  optionDisplay: string | null
  /** proof_versions.ink_names (raw; we store the durable primitive, not a
   *  front/back presentation split). */
  inkNames: string[] | null
  /** Resolved letterpress layer colour NAMES (null for non-letterpress). */
  letterpressFront: string | null
  letterpressCore: string | null
  letterpressBack: string | null
  quantity: number | null
  personQuantities: { name: string; quantity: number }[] | null
  hasPersonalisation: boolean
  /** The agreed custom-quote figure, or null for a grid-priced order. */
  customQuoteTotal: number | null
  contactEmail: string | null
  contactName: string | null
  companyName: string | null
  /** Provenance — which writer stamped it and when. */
  stage: 'create' | 'place'
  capturedBy: string | null
  capturedAt: string
}

export interface OrderSpecSnapshot {
  material: { code: string | null; display_name: string | null } | null
  variant: { display_name: string | null } | null
  finish: { display_name: string } | null
  ink_names: string[]
  letterpress: { front: string | null; core: string | null; back: string | null } | null
  quantity: number | null
  person_quantities: { name: string; quantity: number }[] | null
  has_personalisation: boolean
  custom_quote: boolean
  custom_quote_total: number | null
  contact: { email: string | null; full_name: string | null } | null
  company: { name: string | null } | null
  stage: 'create' | 'place'
  captured_by: string | null
  captured_at: string
}

// The single finish resolver, matching place-order's hand-off logic: a chosen
// material_option wins; otherwise, for a finish-dimension material (metal
// Brushed/Mirror), the finish IS the variant; otherwise there's no finish.
export function resolveFinishDisplay(
  optionDisplay: string | null,
  variantType: string | null,
  variantDisplay: string | null,
): string | null {
  if (optionDisplay) return optionDisplay
  if (variantType === 'finish' && variantDisplay) return variantDisplay
  return null
}

export function buildOrderSpecSnapshot(input: OrderSpecSnapshotInput): OrderSpecSnapshot {
  const inks = (Array.isArray(input.inkNames) ? input.inkNames : [])
    .map((s) => String(s).trim())
    .filter(Boolean)

  const finish = resolveFinishDisplay(input.optionDisplay, input.variantType, input.variantDisplay)

  const hasLetterpress = !!(input.letterpressFront || input.letterpressCore || input.letterpressBack)

  return {
    material: input.materialCode
      ? { code: input.materialCode, display_name: input.materialDisplay ?? null }
      : null,
    variant: input.variantDisplay ? { display_name: input.variantDisplay } : null,
    finish: finish ? { display_name: finish } : null,
    ink_names: inks,
    letterpress: hasLetterpress
      ? { front: input.letterpressFront ?? null, core: input.letterpressCore ?? null, back: input.letterpressBack ?? null }
      : null,
    quantity: input.quantity ?? null,
    person_quantities:
      Array.isArray(input.personQuantities) && input.personQuantities.length > 0
        ? input.personQuantities
        : null,
    has_personalisation: !!input.hasPersonalisation,
    custom_quote: input.customQuoteTotal != null,
    custom_quote_total: input.customQuoteTotal ?? null,
    contact: { email: input.contactEmail ?? null, full_name: input.contactName ?? null },
    company: input.companyName ? { name: input.companyName } : null,
    stage: input.stage,
    captured_by: input.capturedBy ?? null,
    captured_at: input.capturedAt,
  }
}
