export type Currency = 'GBP' | 'EUR' | 'USD'

export interface PublicProof {
  id: string
  customer_name: string
  company: string | null
  created_at: string
}

export interface PublicProofVersion {
  id: string
  proof_id: string
  version_number: number
  image_path: string
  material_display: string
  variant_display: string
  ink_names: string[]
  currency: Currency
  pricing_snapshot: Record<string, number>
  shipping_note: string
  change_notes: string | null
  is_current: boolean
  created_at: string
  // Resolved client-side after fetching — not a DB column.
  signed_image_url?: string
}

export interface AppSettings {
  id: number
  disclaimer_html: string
  updated_at: string
}
