// Thin wrapper around the export-pricing / import-pricing edge functions.
// Export streams binary responses (CSV or ZIP) so we bypass supabase-js's
// JSON-parsing invoke() and call fetch directly — much simpler than
// wrestling with response types. Import is JSON in both directions so
// invoke() is fine.

import { supabase } from './supabase'

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/filename="([^"]+)"|filename=([^;]+)/)
  if (!m) return null
  return (m[1] ?? m[2]).trim()
}

/** Download an export file. Scope values: material:<code>, addon:<code>, surcharges, all. */
export async function downloadPricingExport(scope: string, fallbackFilename: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')

  const url = `${SUPABASE_URL}/functions/v1/export-pricing?scope=${encodeURIComponent(scope)}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Export failed (${resp.status})`)
  }
  const blob = await resp.blob()
  const filename = filenameFromContentDisposition(resp.headers.get('Content-Disposition')) ?? fallbackFilename
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(blobUrl)
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportChange {
  kind: 'price_tier' | 'surcharge' | 'add_on_price'
  id: string
  description: string
  oldValue: string | number | null
  newValue: string | number
}

// Phase 3b.3 adds a creates bucket. One entry covers all three currency
// rows for a single (material, variant, quantity) so the preview UI can
// render one readable row instead of three.
export interface ImportCreate {
  material_slug: string
  variant_label: string
  quantity: number
  gbp: number
  eur: number
  usd: number
}

export interface ImportError {
  file: string
  row?: number
  message: string
}

export interface ImportPreview {
  creates: ImportCreate[]
  changes: ImportChange[]
  unchanged: { description: string }[]
  errors: ImportError[]
  committed: boolean
}

async function postImport(file: File, commit: boolean, scope?: string | null): Promise<ImportPreview> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const form = new FormData()
  form.append('file', file)
  form.append('commit', commit ? 'true' : 'false')
  if (scope) form.append('scope', scope)
  const url = `${SUPABASE_URL}/functions/v1/import-pricing`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  })
  const data = await resp.json()
  if (!resp.ok && !data?.errors) throw new Error(data?.error ?? `Import failed (${resp.status})`)
  // Belt and braces — older server versions don't emit creates; normalise.
  if (!Array.isArray((data as any).creates)) (data as any).creates = []
  return data as ImportPreview
}

export const previewPricingImport = (file: File, scope?: string | null) => postImport(file, false, scope)
export const commitPricingImport  = (file: File, scope?: string | null) => postImport(file, true,  scope)
