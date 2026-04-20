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
  label: string
  sort_order: number
  material_option: string | null
  original_filename: string | null
  // Resolved client-side — not a DB column.
  signed_url?: string
}

export interface AppSettings {
  id: number
  disclaimer_html: string
  updated_at: string
}
