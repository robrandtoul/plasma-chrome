export type Currency = 'GBP' | 'EUR' | 'USD'

export type ProofStatus = 'in_progress' | 'approved' | 'dormant' | 'abandoned'

export interface PublicProof {
  id: string
  customer_name: string
  company: string | null
  created_at: string
  status: ProofStatus
  approved_at: string | null
  abandoned_at: string | null
}

// One entry per variant exposed on a proof version.
// Single-variant materials have one entry; thickness materials may have several.
export interface PricingVariant {
  variant_id: string
  display: string
  prices: Record<string, number> // quantity string → total price in major currency units
}

export interface PricingSnapshot {
  variants: PricingVariant[]
}

export interface PublicProofVersion {
  id: string
  proof_id: string
  version_number: number
  material_id: string
  material_display: string
  ink_names: string[]
  currency: Currency
  pricing_snapshot: PricingSnapshot
  shipping_note: string
  change_notes: string | null
  is_current: boolean
  created_at: string
  material_options: string[]
  featured_quantities: number[]
  material_disclaimer: string | null
  /** Paragraph-style text shown in the customer-facing "About [Material]" block. */
  material_description: string | null
  /** Public URL of the material's icon image. */
  material_icon_url: string | null
  option_label: string | null
  custom_quote: boolean
  // ── Option 2 approval fields (migration 000066) ──────────────────────────
  // All four stay null during option 1 (read-only customer page). The
  // public_proof_versions view will be extended to expose these at the
  // same time the Approve action is wired up, which is why the types
  // here are optional: existing customer queries won't see the keys at
  // all until the view ships.
  approved_at?: string | null
  approved_by_name?: string | null
  approved_from_ip?: string | null
  approved_from_ua?: string | null
  // ── Supersession (migration 000068) ───────────────────────────────────────
  // Null while this version is chronologically-latest for its proof.
  // Stamped to the next version's created_at when a newer sibling
  // lands. Phase 2's customer page will render a "newer version
  // available" banner when this field is populated.
  //
  // approved_while_superseded is deliberately NOT exposed here —
  // it's a designer/audit field and stays off the customer-facing
  // view.
  superseded_at?: string | null
  // ── Split-name tooling (migration 000070) ─────────────────────────────────
  // Named recipients for this proof (e.g. directors on a metal
  // split-name order). Captured per-version. Empty array = no
  // named recipients.
  names: string[]
  // Per-extra-name tooling surcharge in this version's currency,
  // snapshotted at insert/update time from the version's material.
  // Null when the material has no configured surcharge for the
  // chosen currency (carbon CNC, some paper).
  split_name_surcharge_snapshot: number | null
}

export interface PublicMaterialOption {
  id: string
  material_id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

export interface PublicMaterialOptionSurcharge {
  id: string
  material_option_id: string
  currency: Currency
  quantity: number
  surcharge: number
}

export interface SiteSettings {
  global_disclaimer: string | null
}

export interface ProofVersionImage {
  id: string
  proof_version_id: string
  image_path: string
  sort_order: number
  material_option: string | null
  original_filename: string | null
  // ── Name + side association (migration 000071) ───────────────────────────
  // associated_name: null = shared across all names for this version.
  // side: null = not labelled / not applicable.
  associated_name: string | null
  side: 'front' | 'back' | null
  // Resolved client-side — not a DB column.
  signed_url?: string
}

export interface AppSettings {
  id: number
  disclaimer_html: string
  updated_at: string
}
