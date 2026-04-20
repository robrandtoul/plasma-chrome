// Admin-only edge function: parse an uploaded CSV or ZIP and either
// return a diff preview or commit it atomically via the
// apply_pricing_updates RPC.
//
// Request shape (multipart/form-data):
//   file     — the uploaded .csv or .zip
//   commit   — "true" to apply; anything else runs preview-only
//
// Response is always JSON:
//   { changes: [...], unchanged: [...], errors: [...], committed: boolean }
//
// A change row has { id, kind, description, oldValue, newValue } so the
// frontend can render a readable diff table and, on confirmation, POST
// the payload to this function with commit=true.

import JSZip from 'npm:jszip@3.10.1'
import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { parseCsv } from '../_shared/csv.ts'

// ── Types ────────────────────────────────────────────────────────────────────

type Currency = 'GBP' | 'EUR' | 'USD'

interface Change {
  kind: 'price_tier' | 'surcharge' | 'add_on_price'
  id: string
  description: string
  oldValue: string | number | null
  newValue: string | number
  payload: Record<string, string | number>
}

interface Unchanged {
  description: string
}

interface ImportError {
  file: string
  row?: number
  message: string
}

// ── Entry point ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin, user } = check

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ error: 'Expected multipart/form-data upload' }, 400)
  }

  const file = form.get('file')
  const commitFlag = String(form.get('commit') ?? '').toLowerCase() === 'true'

  if (!(file instanceof File)) {
    return json({ error: 'Missing file field' }, 400)
  }

  // Pull all CSVs from the upload — supports a single CSV or a ZIP of CSVs.
  let csvEntries: { name: string; text: string }[] = []
  try {
    csvEntries = await extractCsvEntries(file)
  } catch (e) {
    return json({ error: (e as Error).message ?? 'Upload parse failed' }, 400)
  }
  if (csvEntries.length === 0) {
    return json({ error: 'No CSV files found in upload' }, 400)
  }

  // Build lookup maps for natural-key resolution.
  const lookups = await loadLookups(admin)

  const changes: Change[] = []
  const unchanged: Unchanged[] = []
  const errors: ImportError[] = []

  for (const entry of csvEntries) {
    try {
      await processCsv(entry.name, entry.text, lookups, changes, unchanged, errors)
    } catch (e) {
      errors.push({ file: entry.name, message: (e as Error).message })
    }
  }

  if (!commitFlag) {
    return json({ changes, unchanged, errors, committed: false })
  }

  if (errors.length > 0) {
    return json({ changes, unchanged, errors, committed: false, error: 'Refusing to commit while errors remain' }, 400)
  }
  if (changes.length === 0) {
    return json({ changes, unchanged, errors, committed: false, error: 'Nothing to change' }, 400)
  }

  const payload = changes.map((c) => ({ kind: c.kind, id: c.id, ...c.payload }))
  // Call the RPC with the user's JWT so is_admin() inside the function
  // sees the correct auth.uid(). Service role has no user context.
  const { error: rpcErr } = await user.rpc('apply_pricing_updates', { updates: payload })
  if (rpcErr) {
    return json({ changes, unchanged, errors: [{ file: '-', message: rpcErr.message }], committed: false }, 500)
  }
  return json({ changes, unchanged, errors, committed: true })
})

// ── ZIP + file extraction ───────────────────────────────────────────────────

async function extractCsvEntries(file: File): Promise<{ name: string; text: string }[]> {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.csv')) {
    return [{ name: file.name, text: await file.text() }]
  }
  if (lowerName.endsWith('.zip')) {
    const buf = new Uint8Array(await file.arrayBuffer())
    const zip = await JSZip.loadAsync(buf)
    const out: { name: string; text: string }[] = []
    const names = Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.csv'))
    for (const n of names) {
      const f = zip.files[n]
      if (f.dir) continue
      out.push({ name: n, text: await f.async('string') })
    }
    return out
  }
  throw new Error(`Unsupported file type: ${file.name}`)
}

// ── Lookup maps ─────────────────────────────────────────────────────────────

interface Lookups {
  materialsByCode: Map<string, {
    id: string
    code: string
    split_name_surcharge_gbp: number | null
    split_name_surcharge_eur: number | null
    split_name_surcharge_usd: number | null
  }>
  variantsByMaterialIdAndLabel: Map<string, {
    id: string
    display_name: string
    variant_type: string
    material_id: string
  }>
  variantLabelsByMaterial: Map<string, string[]>
  tierByKey: Map<string, { id: string; total_price: number }>
  addOnsByCode: Map<string, { id: string; code: string; pricing_model: string }>
  addOnPriceByKey: Map<string, { id: string; surcharge: number }>
}

/** PostgREST caps each response at 1000 rows by default; paginate until
 *  we've read everything for the tables that can exceed that. */
async function fetchAll<T>(builder: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await builder().range(from, from + pageSize - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

async function loadLookups(admin: any): Promise<Lookups> {
  const [matsResult, varsResult, aosResult, apricesResult, allTiers] = await Promise.all([
    admin.from('materials').select('id, code, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd'),
    admin.from('material_variants').select('id, display_name, variant_type, material_id'),
    admin.from('add_ons').select('id, code, pricing_model'),
    admin.from('add_on_prices').select('id, add_on_id, currency, quantity, surcharge'),
    fetchAll<{ id: string; material_variant_id: string; currency: string; quantity: number; total_price: number }>(
      () => admin.from('price_tiers').select('id, material_variant_id, currency, quantity, total_price'),
    ),
  ])
  const tiersResult = { data: allTiers }

  const materialsByCode = new Map<string, any>()
  for (const m of (matsResult.data ?? [])) materialsByCode.set(m.code.toLowerCase(), m)

  const variantsByMaterialIdAndLabel = new Map<string, any>()
  const variantLabelsByMaterial = new Map<string, string[]>()
  for (const v of (varsResult.data ?? [])) {
    const key = `${v.material_id}|${v.display_name.trim().toLowerCase()}`
    variantsByMaterialIdAndLabel.set(key, v)
    const list = variantLabelsByMaterial.get(v.material_id) ?? []
    list.push(v.display_name)
    variantLabelsByMaterial.set(v.material_id, list)
  }

  const tierByKey = new Map<string, any>()
  for (const t of (tiersResult.data ?? [])) {
    const key = `${t.material_variant_id}|${t.currency}|${t.quantity}`
    tierByKey.set(key, { id: t.id, total_price: Number(t.total_price) })
  }

  const addOnsByCode = new Map<string, any>()
  for (const a of (aosResult.data ?? [])) addOnsByCode.set(a.code.toLowerCase(), a)

  const addOnPriceByKey = new Map<string, any>()
  for (const p of (apricesResult.data ?? [])) {
    const qty = p.quantity == null ? 'flat' : String(p.quantity)
    const key = `${p.add_on_id}|${p.currency}|${qty}`
    addOnPriceByKey.set(key, { id: p.id, surcharge: Number(p.surcharge) })
  }

  return {
    materialsByCode,
    variantsByMaterialIdAndLabel,
    variantLabelsByMaterial,
    tierByKey,
    addOnsByCode,
    addOnPriceByKey,
  }
}

// ── CSV dispatch + per-file handlers ────────────────────────────────────────

async function processCsv(
  fileName: string,
  text: string,
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  const rows = parseCsv(text)
  if (rows.length === 0) {
    errors.push({ file: fileName, message: 'File is empty' })
    return
  }
  const header = rows[0].map((h) => h.trim().toLowerCase())

  if (sameHeaders(header, ['material_slug', 'variant_label', 'variant_type', 'quantity', 'gbp_total', 'eur_total', 'usd_total'])) {
    processPriceTiers(fileName, rows, lookups, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['material_slug', 'gbp_surcharge', 'eur_surcharge', 'usd_surcharge'])) {
    processSurcharges(fileName, rows, lookups, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['addon_slug', 'pricing_model', 'quantity', 'gbp_price', 'eur_price', 'usd_price'])) {
    processAddOnPerTier(fileName, rows, lookups, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['addon_slug', 'pricing_model', 'gbp_price', 'eur_price', 'usd_price'])) {
    processAddOnFlat(fileName, rows, lookups, changes, unchanged, errors)
    return
  }
  errors.push({
    file: fileName,
    message: `Unrecognised header row: ${header.join(', ')}. Expected one of the three pricing CSV formats.`,
  })
}

function sameHeaders(got: string[], expected: string[]): boolean {
  if (got.length !== expected.length) return false
  return expected.every((h, i) => got[i] === h)
}

// ── Price tiers ─────────────────────────────────────────────────────────────

function processPriceTiers(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.every((c) => c.trim() === '')) continue
    if (r.length < 7) {
      errors.push({ file: fileName, row: lineNo, message: `Expected 7 columns, got ${r.length}` })
      continue
    }
    const [slug, variantLabel, variantType, qtyStr, gbp, eur, usd] = r.map((c) => c.trim())
    const mat = lookups.materialsByCode.get(slug.toLowerCase())
    if (!mat) {
      errors.push({ file: fileName, row: lineNo, message: `Material '${slug}' not found.` })
      continue
    }
    const variant = lookups.variantsByMaterialIdAndLabel.get(`${mat.id}|${variantLabel.toLowerCase()}`)
    if (!variant) {
      const available = (lookups.variantLabelsByMaterial.get(mat.id) ?? []).join(', ')
      errors.push({
        file: fileName,
        row: lineNo,
        message: `Variant '${variantLabel}' not found for material '${slug}'. Available variants: ${available || '(none)'}.`,
      })
      continue
    }
    if (variant.variant_type !== variantType) {
      errors.push({
        file: fileName,
        row: lineNo,
        message: `variant_type mismatch for ${slug}/${variantLabel}: expected '${variant.variant_type}', got '${variantType}'.`,
      })
      continue
    }
    const qty = parseInt(qtyStr, 10)
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ file: fileName, row: lineNo, message: `quantity '${qtyStr}' is not a positive integer.` })
      continue
    }

    const currencies: Array<[Currency, string]> = [['GBP', gbp], ['EUR', eur], ['USD', usd]]
    for (const [cur, raw] of currencies) {
      if (raw === '') {
        errors.push({ file: fileName, row: lineNo, message: `${cur.toLowerCase()}_total is empty. All three currency columns must be filled.` })
        continue
      }
      const num = Number(raw)
      if (!Number.isFinite(num) || num < 0) {
        errors.push({ file: fileName, row: lineNo, message: `${cur.toLowerCase()}_total '${raw}' is not a non-negative number.` })
        continue
      }
      const tierKey = `${variant.id}|${cur}|${qty}`
      const tier = lookups.tierByKey.get(tierKey)
      if (!tier) {
        errors.push({
          file: fileName,
          row: lineNo,
          message: `quantity ${qty} not found for variant '${variantLabel}' in ${cur}. Cannot add new tiers in this view.`,
        })
        continue
      }
      const oldTotal = tier.total_price
      if (num === oldTotal) {
        unchanged.push({ description: `${slug} / ${variantLabel} / ${qty} / ${cur}: ${oldTotal}` })
        continue
      }
      const unit = Number((num / qty).toFixed(4))
      changes.push({
        kind: 'price_tier',
        id: tier.id,
        description: `${slug} / ${variantLabel} / ${qty} / ${cur}`,
        oldValue: oldTotal,
        newValue: num,
        payload: { total_price: num, unit_price: unit },
      })
    }
  }
}

// ── Surcharges ──────────────────────────────────────────────────────────────

function processSurcharges(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.every((c) => c.trim() === '')) continue
    if (r.length < 4) {
      errors.push({ file: fileName, row: lineNo, message: `Expected 4 columns, got ${r.length}` })
      continue
    }
    const [slug, gbp, eur, usd] = r.map((c) => c.trim())
    const mat = lookups.materialsByCode.get(slug.toLowerCase())
    if (!mat) {
      errors.push({ file: fileName, row: lineNo, message: `Material '${slug}' not found.` })
      continue
    }
    const parsed: Record<string, number | null> = {}
    for (const [col, raw, currency] of [['gbp', gbp, 'GBP'], ['eur', eur, 'EUR'], ['usd', usd, 'USD']] as const) {
      if (raw === '') { parsed[col] = null; continue }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ file: fileName, row: lineNo, message: `${col}_surcharge '${raw}' is not a non-negative number.` })
        parsed[col] = null
        continue
      }
      parsed[col] = n
      // Silence unused-var warning
      void currency
    }
    const current = { gbp: mat.split_name_surcharge_gbp, eur: mat.split_name_surcharge_eur, usd: mat.split_name_surcharge_usd }
    const same = (a: number | null, b: number | null) => (a == null ? b == null : a === b)
    if (same(parsed.gbp ?? null, current.gbp == null ? null : Number(current.gbp))
      && same(parsed.eur ?? null, current.eur == null ? null : Number(current.eur))
      && same(parsed.usd ?? null, current.usd == null ? null : Number(current.usd))) {
      unchanged.push({ description: `Surcharge for ${slug}` })
      continue
    }
    changes.push({
      kind: 'surcharge',
      id: mat.id,
      description: `Surcharge for ${slug}`,
      oldValue: `£${current.gbp ?? '—'} / €${current.eur ?? '—'} / $${current.usd ?? '—'}`,
      newValue: `£${parsed.gbp ?? '—'} / €${parsed.eur ?? '—'} / $${parsed.usd ?? '—'}`,
      payload: {
        gbp: parsed.gbp == null ? '' : String(parsed.gbp),
        eur: parsed.eur == null ? '' : String(parsed.eur),
        usd: parsed.usd == null ? '' : String(parsed.usd),
      },
    })
  }
}

// ── Add-on per-tier ─────────────────────────────────────────────────────────

function processAddOnPerTier(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.every((c) => c.trim() === '')) continue
    if (r.length < 6) {
      errors.push({ file: fileName, row: lineNo, message: `Expected 6 columns, got ${r.length}` })
      continue
    }
    const [slug, model, qtyStr, gbp, eur, usd] = r.map((c) => c.trim())
    const ao = lookups.addOnsByCode.get(slug.toLowerCase())
    if (!ao) {
      errors.push({ file: fileName, row: lineNo, message: `Add-on '${slug}' not found.` })
      continue
    }
    if (ao.pricing_model !== 'per_quantity_tier') {
      errors.push({ file: fileName, row: lineNo, message: `Add-on '${slug}' has pricing_model '${ao.pricing_model}', not 'per_quantity_tier'. Wrong file type?` })
      continue
    }
    if (model !== 'per_quantity_tier') {
      errors.push({ file: fileName, row: lineNo, message: `pricing_model column '${model}' doesn't match the DB ('${ao.pricing_model}').` })
      continue
    }
    const qty = parseInt(qtyStr, 10)
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ file: fileName, row: lineNo, message: `quantity '${qtyStr}' is not a positive integer.` })
      continue
    }
    checkAddOnCell(fileName, lineNo, ao, qty, 'GBP', gbp, lookups, changes, unchanged, errors)
    checkAddOnCell(fileName, lineNo, ao, qty, 'EUR', eur, lookups, changes, unchanged, errors)
    checkAddOnCell(fileName, lineNo, ao, qty, 'USD', usd, lookups, changes, unchanged, errors)
  }
}

// ── Add-on flat ─────────────────────────────────────────────────────────────

function processAddOnFlat(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.every((c) => c.trim() === '')) continue
    if (r.length < 5) {
      errors.push({ file: fileName, row: lineNo, message: `Expected 5 columns, got ${r.length}` })
      continue
    }
    const [slug, model, gbp, eur, usd] = r.map((c) => c.trim())
    const ao = lookups.addOnsByCode.get(slug.toLowerCase())
    if (!ao) {
      errors.push({ file: fileName, row: lineNo, message: `Add-on '${slug}' not found.` })
      continue
    }
    if (ao.pricing_model !== 'flat') {
      errors.push({ file: fileName, row: lineNo, message: `Add-on '${slug}' has pricing_model '${ao.pricing_model}', not 'flat'. Wrong file type?` })
      continue
    }
    if (model !== 'flat') {
      errors.push({ file: fileName, row: lineNo, message: `pricing_model column '${model}' doesn't match the DB ('${ao.pricing_model}').` })
      continue
    }
    checkAddOnCell(fileName, lineNo, ao, null, 'GBP', gbp, lookups, changes, unchanged, errors)
    checkAddOnCell(fileName, lineNo, ao, null, 'EUR', eur, lookups, changes, unchanged, errors)
    checkAddOnCell(fileName, lineNo, ao, null, 'USD', usd, lookups, changes, unchanged, errors)
  }
}

function checkAddOnCell(
  fileName: string,
  lineNo: number,
  ao: { id: string; code: string; pricing_model: string },
  qty: number | null,
  currency: Currency,
  raw: string,
  lookups: Lookups,
  changes: Change[],
  unchanged: Unchanged[],
  errors: ImportError[],
) {
  if (raw === '') {
    errors.push({ file: fileName, row: lineNo, message: `${currency.toLowerCase()}_price is empty. All three currency columns must be filled.` })
    return
  }
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 0) {
    errors.push({ file: fileName, row: lineNo, message: `${currency.toLowerCase()}_price '${raw}' is not a non-negative number.` })
    return
  }
  const key = `${ao.id}|${currency}|${qty == null ? 'flat' : String(qty)}`
  const existing = lookups.addOnPriceByKey.get(key)
  if (!existing) {
    errors.push({
      file: fileName,
      row: lineNo,
      message: qty == null
        ? `No flat ${currency} price set for '${ao.code}'. Cannot add new rows in this view.`
        : `quantity ${qty} not found for add-on '${ao.code}' in ${currency}. Cannot add new rows in this view.`,
    })
    return
  }
  if (num === existing.surcharge) {
    unchanged.push({ description: `${ao.code} / ${qty == null ? 'flat' : qty} / ${currency}: ${existing.surcharge}` })
    return
  }
  changes.push({
    kind: 'add_on_price',
    id: existing.id,
    description: `${ao.code} / ${qty == null ? 'flat' : qty} / ${currency}`,
    oldValue: existing.surcharge,
    newValue: num,
    payload: { surcharge: num },
  })
}
