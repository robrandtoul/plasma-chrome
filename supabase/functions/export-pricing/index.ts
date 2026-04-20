// Admin-only edge function: export pricing as CSV (or a bundled ZIP for
// scope=all). Scope is passed via ?scope= query param:
//   material:metal_steel         → single CSV for that material
//   addon:metal_finish_upgrade   → single CSV for that add-on
//   surcharges                   → the surcharges CSV
//   all                          → ZIP containing all of the above
//
// JSZip is pulled in via Deno's npm compatibility. It gives us a small,
// well-tested ZIP writer with no native dependencies.

import JSZip from 'npm:jszip@3.10.1'
import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { toCsv } from '../_shared/csv.ts'

const PRICE_TIER_HEADER = ['material_slug', 'variant_label', 'variant_type', 'quantity', 'gbp_total', 'eur_total', 'usd_total']
const SURCHARGE_HEADER = ['material_slug', 'gbp_surcharge', 'eur_surcharge', 'usd_surcharge']
const ADDON_TIER_HEADER = ['addon_slug', 'pricing_model', 'quantity', 'gbp_price', 'eur_price', 'usd_price']
const ADDON_FLAT_HEADER = ['addon_slug', 'pricing_model', 'gbp_price', 'eur_price', 'usd_price']

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function numOrEmpty(n: number | null | undefined): string {
  if (n == null) return ''
  return String(n)
}

async function buildMaterialCsv(admin: any, materialCode: string): Promise<string> {
  const { data: mat } = await admin.from('materials').select('id, code').eq('code', materialCode).single()
  if (!mat) throw new Error(`Material not found: ${materialCode}`)
  const { data: variants } = await admin.from('material_variants')
    .select('id, display_name, variant_type')
    .eq('material_id', mat.id)
    .order('sort_order')
  const variantIds = (variants ?? []).map((v: any) => v.id)
  const { data: tiers } = await admin.from('price_tiers')
    .select('material_variant_id, currency, quantity, total_price')
    .in('material_variant_id', variantIds.length ? variantIds : ['00000000-0000-0000-0000-000000000000'])
    .order('quantity')

  const tierRow: Record<string, Record<string, number>> = {}
  for (const t of (tiers ?? [])) {
    const key = `${t.material_variant_id}|${t.quantity}`
    if (!tierRow[key]) tierRow[key] = {}
    tierRow[key][t.currency] = Number(t.total_price)
  }

  const rows: (string | number)[][] = [PRICE_TIER_HEADER]
  for (const v of (variants ?? [])) {
    // Build a unique sorted list of quantities for this variant.
    const qtys = new Set<number>()
    for (const t of (tiers ?? [])) if (t.material_variant_id === v.id) qtys.add(t.quantity)
    for (const qty of [...qtys].sort((a, b) => a - b)) {
      const cell = tierRow[`${v.id}|${qty}`] ?? {}
      rows.push([
        mat.code,
        v.display_name,
        v.variant_type,
        qty,
        numOrEmpty(cell.GBP),
        numOrEmpty(cell.EUR),
        numOrEmpty(cell.USD),
      ])
    }
  }
  return toCsv(rows)
}

async function buildSurchargesCsv(admin: any): Promise<string> {
  const { data: mats } = await admin.from('materials')
    .select('code, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
    .eq('is_active', true)
    .order('sort_order')
  const rows: (string | number)[][] = [SURCHARGE_HEADER]
  for (const m of (mats ?? [])) {
    rows.push([m.code, numOrEmpty(m.split_name_surcharge_gbp), numOrEmpty(m.split_name_surcharge_eur), numOrEmpty(m.split_name_surcharge_usd)])
  }
  return toCsv(rows)
}

async function buildAddOnCsv(admin: any, addonCode: string): Promise<string | null> {
  const { data: ao } = await admin.from('add_ons').select('id, code, pricing_model').eq('code', addonCode).single()
  if (!ao) throw new Error(`Add-on not found: ${addonCode}`)
  if (ao.pricing_model === 'custom_quote') return null // nothing to export

  const { data: prices } = await admin.from('add_on_prices')
    .select('currency, quantity, surcharge')
    .eq('add_on_id', ao.id)
    .order('quantity')

  if (ao.pricing_model === 'flat') {
    const rows: (string | number)[][] = [ADDON_FLAT_HEADER]
    const byCurrency: Record<string, number> = {}
    for (const p of (prices ?? [])) if (p.quantity == null) byCurrency[p.currency] = Number(p.surcharge)
    rows.push([ao.code, 'flat', numOrEmpty(byCurrency.GBP), numOrEmpty(byCurrency.EUR), numOrEmpty(byCurrency.USD)])
    return toCsv(rows)
  }

  // per_quantity_tier
  const rows: (string | number)[][] = [ADDON_TIER_HEADER]
  const byKey: Record<number, Record<string, number>> = {}
  const qtys = new Set<number>()
  for (const p of (prices ?? [])) {
    if (p.quantity == null) continue
    if (!byKey[p.quantity]) byKey[p.quantity] = {}
    byKey[p.quantity][p.currency] = Number(p.surcharge)
    qtys.add(p.quantity)
  }
  for (const qty of [...qtys].sort((a, b) => a - b)) {
    const cell = byKey[qty] ?? {}
    rows.push([ao.code, 'per_quantity_tier', qty, numOrEmpty(cell.GBP), numOrEmpty(cell.EUR), numOrEmpty(cell.USD)])
  }
  return toCsv(rows)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin } = check

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') ?? ''

  try {
    if (scope.startsWith('material:')) {
      const code = scope.slice('material:'.length)
      const csv = await buildMaterialCsv(admin, code)
      return new Response(csv, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="pricing_${code}.csv"`,
        },
      })
    }

    if (scope.startsWith('addon:')) {
      const code = scope.slice('addon:'.length)
      const csv = await buildAddOnCsv(admin, code)
      if (csv == null) return json({ error: 'This add-on has no exportable prices (custom_quote).' }, 400)
      return new Response(csv, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="pricing_addon_${code}.csv"`,
        },
      })
    }

    if (scope === 'surcharges') {
      const csv = await buildSurchargesCsv(admin)
      return new Response(csv, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="pricing_surcharges.csv"`,
        },
      })
    }

    if (scope === 'all') {
      const { data: materials } = await admin.from('materials').select('code').eq('is_active', true).order('sort_order')
      const { data: addOns } = await admin.from('add_ons').select('code, pricing_model').eq('is_active', true).order('display_name')

      const zip = new JSZip()
      for (const m of (materials ?? [])) {
        const csv = await buildMaterialCsv(admin, m.code)
        zip.file(`pricing_${m.code}.csv`, csv)
      }
      for (const a of (addOns ?? [])) {
        if (a.pricing_model === 'custom_quote') continue
        const csv = await buildAddOnCsv(admin, a.code)
        if (csv != null) zip.file(`pricing_addon_${a.code}.csv`, csv)
      }
      zip.file('pricing_surcharges.csv', await buildSurchargesCsv(admin))

      const bytes = await zip.generateAsync({ type: 'uint8array' })
      return new Response(bytes, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="pricing_export_${today()}.zip"`,
        },
      })
    }

    return json({ error: 'Unknown scope. Expected material:<code>, addon:<code>, surcharges, or all.' }, 400)
  } catch (err) {
    console.error('export-pricing error:', err)
    return json({ error: (err as Error).message ?? 'Export failed' }, 500)
  }
})
