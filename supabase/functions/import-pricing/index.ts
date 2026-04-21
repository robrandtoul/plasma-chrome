// Admin-only edge function: parse an uploaded CSV or ZIP and either
// return a diff preview or commit it atomically via the
// apply_pricing_updates RPC.
//
// Request shape (multipart/form-data):
//   file     — the uploaded .csv or .zip
//   commit   — "true" to apply; anything else runs preview-only
//   scope    — optional material slug. When present, price_tier and
//              surcharge rows for other materials become errors, and
//              add-on CSVs are rejected. Drives the per-material import
//              button on AdminMaterialEditor.
//
// Response is always JSON:
//   { creates: [...], changes: [...], unchanged: [...], errors: [...], committed: boolean }
//
// A create entry groups the three currency rows for a single
// (material, variant, quantity) into one preview row so the UI can
// render it as one logical "new tier". The actual RPC payload expands
// each create to three price_tier_created rows. A change entry stays
// per-currency, matching the existing update granularity.

import JSZip from 'npm:jszip@3.10.1'
import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { parseCsv } from '../_shared/csv.ts'
import { logAudit } from '../_shared/audit.ts'

// ── Types ────────────────────────────────────────────────────────────────────

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

interface Change {
  kind: 'price_tier' | 'surcharge' | 'add_on_price'
  id: string
  description: string
  oldValue: string | number | null
  newValue: string | number
  payload: Record<string, string | number>
  // Per-row metadata kept on the server for audit emission (not sent to UI).
  meta?: {
    materialSlug: string
    variantLabel: string
    quantity: number
    currency: Currency
  }
}

interface Create {
  material_slug: string
  variant_label: string
  material_variant_id: string
  quantity: number
  gbp: number
  eur: number
  usd: number
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
  const { admin, user, callerId, callerEmail, callerLabel } = check

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ error: 'Expected multipart/form-data upload' }, 400)
  }

  const file = form.get('file')
  const commitFlag = String(form.get('commit') ?? '').toLowerCase() === 'true'
  const scopeRaw = form.get('scope')
  const scope = typeof scopeRaw === 'string' && scopeRaw.trim() !== ''
    ? scopeRaw.trim().toLowerCase()
    : null

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

  const creates: Create[] = []
  const changes: Change[] = []
  const unchanged: Unchanged[] = []
  const errors: ImportError[] = []

  for (const entry of csvEntries) {
    try {
      await processCsv(entry.name, entry.text, lookups, scope, creates, changes, unchanged, errors)
    } catch (e) {
      errors.push({ file: entry.name, message: (e as Error).message })
    }
  }

  if (!commitFlag) {
    return json({ creates, changes, unchanged, errors, committed: false })
  }

  if (errors.length > 0) {
    return json({ creates, changes, unchanged, errors, committed: false, error: 'Refusing to commit while errors remain' }, 400)
  }
  if (creates.length === 0 && changes.length === 0) {
    return json({ creates, changes, unchanged, errors, committed: false, error: 'Nothing to change' }, 400)
  }

  // Build RPC payload. Creates expand to three rows per (variant, qty).
  const payload: unknown[] = []
  for (const c of creates) {
    for (const cur of CURRENCIES) {
      const total = cur === 'GBP' ? c.gbp : cur === 'EUR' ? c.eur : c.usd
      const unit = Number((total / c.quantity).toFixed(4))
      payload.push({
        kind: 'price_tier_created',
        material_variant_id: c.material_variant_id,
        currency: cur,
        quantity: c.quantity,
        total_price: total,
        unit_price: unit,
      })
    }
  }
  for (const ch of changes) {
    payload.push({ kind: ch.kind, id: ch.id, ...ch.payload })
  }

  // Call the RPC with the user's JWT so is_admin() inside the function
  // sees the correct auth.uid(). Service role has no user context.
  const { error: rpcErr } = await user.rpc('apply_pricing_updates', { updates: payload })
  if (rpcErr) {
    return json({ creates, changes, unchanged, errors: [{ file: '-', message: rpcErr.message }], committed: false }, 500)
  }

  // ── Per-row audit events ─────────────────────────────────────────────
  //
  // For updates, the id is already in the change payload. For creates,
  // we have to look up the freshly-inserted rows by natural key because
  // the RPC doesn't return them. One batch SELECT filtered to the
  // relevant variants keeps it cheap, and if any lookup misses (e.g.
  // another admin deleted the row between commit and audit) we still
  // write the event with a null targetId.

  const createdIdByKey = new Map<string, string>()
  if (creates.length > 0) {
    const variantIds = [...new Set(creates.map((c) => c.material_variant_id))]
    const { data: createdRows } = await admin
      .from('price_tiers')
      .select('id, material_variant_id, currency, quantity')
      .in('material_variant_id', variantIds)
    for (const r of createdRows ?? []) {
      createdIdByKey.set(`${r.material_variant_id}|${r.currency}|${r.quantity}`, r.id)
    }
  }

  for (const c of creates) {
    for (const cur of CURRENCIES) {
      const total = cur === 'GBP' ? c.gbp : cur === 'EUR' ? c.eur : c.usd
      const key = `${c.material_variant_id}|${cur}|${c.quantity}`
      await logAudit(admin, {
        actorId: callerId,
        actorEmail: callerEmail,
        actorLabel: callerLabel,
        action: 'price_tier_created',
        targetType: 'price_tier',
        targetId: createdIdByKey.get(key) ?? null,
        targetLabel: `${c.material_slug} — ${c.variant_label} — ${c.quantity} (${cur})`,
        afterValue: { currency: cur, quantity: c.quantity, total_price: total },
        metadata: { source: 'csv_import', file: file.name },
      })
    }
  }

  for (const ch of changes) {
    if (ch.kind !== 'price_tier' || !ch.meta) continue // surcharge + add_on stay coarse
    await logAudit(admin, {
      actorId: callerId,
      actorEmail: callerEmail,
      actorLabel: callerLabel,
      action: 'price_tier.updated',
      targetType: 'price_tier',
      targetId: ch.id,
      targetLabel: `${ch.meta.materialSlug} — ${ch.meta.variantLabel} — ${ch.meta.quantity} (${ch.meta.currency})`,
      beforeValue: { currency: ch.meta.currency, total_price: ch.oldValue },
      afterValue: { currency: ch.meta.currency, total_price: ch.newValue },
      metadata: { source: 'csv_import', file: file.name },
    })
  }

  // Existing batch marker. Kept coarse so activity-log filters can
  // surface the one-event-per-import view, and extended with
  // rows_created so the aggregate totals are complete.
  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'pricing.imported',
    targetType: 'pricing',
    targetLabel: file.name,
    metadata: {
      filename: file.name,
      scope,
      rows_created: creates.length * 3,
      rows_changed: changes.length,
      rows_unchanged: unchanged.length,
      errors: 0,
    },
  })

  return json({ creates, changes, unchanged, errors, committed: true })
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
  scope: string | null,
  creates: Create[],
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
    processPriceTiers(fileName, rows, lookups, scope, creates, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['material_slug', 'gbp_surcharge', 'eur_surcharge', 'usd_surcharge'])) {
    processSurcharges(fileName, rows, lookups, scope, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['addon_slug', 'pricing_model', 'quantity', 'gbp_price', 'eur_price', 'usd_price'])) {
    if (scope) {
      errors.push({ file: fileName, message: `Add-on imports aren't available in scoped mode. Use the global import at /admin/pricing for add-ons.` })
      return
    }
    processAddOnPerTier(fileName, rows, lookups, changes, unchanged, errors)
    return
  }
  if (sameHeaders(header, ['addon_slug', 'pricing_model', 'gbp_price', 'eur_price', 'usd_price'])) {
    if (scope) {
      errors.push({ file: fileName, message: `Add-on imports aren't available in scoped mode. Use the global import at /admin/pricing for add-ons.` })
      return
    }
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

function parsePositiveNumber(raw: string): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function processPriceTiers(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  scope: string | null,
  creates: Create[],
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

    // Scope filter: in per-material mode, rows for other materials
    // become errors rather than being silently ignored.
    if (scope && slug.toLowerCase() !== scope) {
      errors.push({ file: fileName, row: lineNo, message: `Row is for '${slug}' but this import is scoped to '${scope}'. Wrong material for this import.` })
      continue
    }

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

    // Per-currency existence check. If all three tuples are missing
    // we're creating a brand-new tier; if all three exist we're on
    // the update path; anything partial is malformed state the admin
    // should resolve manually before importing.
    const rawByCur: Record<Currency, string> = { GBP: gbp, EUR: eur, USD: usd }
    const existingByCur: Partial<Record<Currency, { id: string; total_price: number }>> = {}
    for (const cur of CURRENCIES) {
      const hit = lookups.tierByKey.get(`${variant.id}|${cur}|${qty}`)
      if (hit) existingByCur[cur] = hit
    }
    const existCount = Object.keys(existingByCur).length

    if (existCount === 0) {
      // Create path. Require all three currencies populated.
      const parsed: Partial<Record<Currency, number>> = {}
      let rowBad = false
      for (const cur of CURRENCIES) {
        const raw = rawByCur[cur]
        if (raw === '') {
          errors.push({ file: fileName, row: lineNo, message: `New tier requires GBP, EUR and USD. Missing ${cur.toLowerCase()}_total for ${slug}/${variantLabel} @ qty ${qty}.` })
          rowBad = true
          continue
        }
        const n = parsePositiveNumber(raw)
        if (n === null) {
          errors.push({ file: fileName, row: lineNo, message: `${cur.toLowerCase()}_total '${raw}' is not a non-negative number.` })
          rowBad = true
          continue
        }
        parsed[cur] = n
      }
      if (rowBad) continue
      creates.push({
        material_slug: mat.code,
        variant_label: variant.display_name,
        material_variant_id: variant.id,
        quantity: qty,
        gbp: parsed.GBP!,
        eur: parsed.EUR!,
        usd: parsed.USD!,
      })
      continue
    }

    if (existCount !== 3) {
      // Partial tier state. Rare — seed data is always all-or-nothing —
      // but catch it explicitly so we don't silently half-create.
      const missing = CURRENCIES.filter((c) => !existingByCur[c]).join(', ')
      errors.push({
        file: fileName,
        row: lineNo,
        message: `Partial tier state for ${slug}/${variantLabel} @ qty ${qty}. Only ${Object.keys(existingByCur).join(', ')} exist; ${missing} missing. Fix via the pricing editor before importing.`,
      })
      continue
    }

    // Update path. All three tuples exist. Blank currency = no change
    // for that cell (Phase 3b.3 behaviour — prior to this version the
    // parser erroed on any blank; admins couldn't update one currency
    // without restating the other two).
    for (const cur of CURRENCIES) {
      const raw = rawByCur[cur]
      const tier = existingByCur[cur]!
      if (raw === '') {
        unchanged.push({ description: `${slug} / ${variantLabel} / ${qty} / ${cur}: ${tier.total_price} (blank in CSV)` })
        continue
      }
      const n = parsePositiveNumber(raw)
      if (n === null) {
        errors.push({ file: fileName, row: lineNo, message: `${cur.toLowerCase()}_total '${raw}' is not a non-negative number.` })
        continue
      }
      if (n === tier.total_price) {
        unchanged.push({ description: `${slug} / ${variantLabel} / ${qty} / ${cur}: ${tier.total_price}` })
        continue
      }
      const unit = Number((n / qty).toFixed(4))
      changes.push({
        kind: 'price_tier',
        id: tier.id,
        description: `${slug} / ${variantLabel} / ${qty} / ${cur}`,
        oldValue: tier.total_price,
        newValue: n,
        payload: { total_price: n, unit_price: unit },
        meta: { materialSlug: slug, variantLabel, quantity: qty, currency: cur },
      })
    }
  }
}

// ── Surcharges ──────────────────────────────────────────────────────────────

function processSurcharges(
  fileName: string,
  rows: string[][],
  lookups: Lookups,
  scope: string | null,
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

    if (scope && slug.toLowerCase() !== scope) {
      errors.push({ file: fileName, row: lineNo, message: `Row is for '${slug}' but this import is scoped to '${scope}'. Wrong material for this import.` })
      continue
    }

    const mat = lookups.materialsByCode.get(slug.toLowerCase())
    if (!mat) {
      errors.push({ file: fileName, row: lineNo, message: `Material '${slug}' not found.` })
      continue
    }
    const parsed: Record<string, number | null> = {}
    for (const [col, raw] of [['gbp', gbp], ['eur', eur], ['usd', usd]] as const) {
      if (raw === '') { parsed[col] = null; continue }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ file: fileName, row: lineNo, message: `${col}_surcharge '${raw}' is not a non-negative number.` })
        parsed[col] = null
        continue
      }
      parsed[col] = n
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
