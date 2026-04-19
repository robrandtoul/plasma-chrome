export type Currency = 'GBP' | 'EUR' | 'USD'

export interface PublicProof {
  id: string
  customer_name: string
  company: string | null
  created_at: string
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
  featured_quantities: number[]
}

export interface ProofVersionImage {
  id: string
  proof_version_id: string
  image_path: string
  label: string
  sort_order: number
  // Resolved client-side — not a DB column.
  signed_url?: string
}

export interface AppSettings {
  id: number
  disclaimer_html: string
  updated_at: string
}
