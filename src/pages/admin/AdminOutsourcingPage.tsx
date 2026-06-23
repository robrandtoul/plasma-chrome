import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { DEFAULT_BODIES } from '../../lib/replyTemplates'

// Admin: outsourcing (supplier) configuration.
//
// Two things live here, both previously hard-coded in the place-order edge
// function:
//   1. Routing — per supplier-route material, the "Material:" product type the
//      supplier email carries (must match a Stock Control product type) and
//      which supplier(s) the order may go to. One supplier → used automatically;
//      several → the person placing the order picks (no default).
//   2. The supplier-order email template (the human wrapper; the machine-
//      generated spec block is injected as {order_details} and is not editable).
//
// Suppliers + product types are Stock Control's data (public schema), read live
// here so adding a supplier there flows through without a redeploy. The routing
// choice (which of them per material) is proof-viewer's, stored on
// proofs.materials.outsourced_product_type / outsourced_supplier_ids.

interface MaterialRow {
  id: string
  display_name: string
  category: string
  outsourced_product_type: string | null
  outsourced_supplier_ids: string[] | null
}
interface Supplier { id: string; name: string; email: string | null; is_international: boolean }
interface ProductType { id: string; name: string }

interface Draft { productType: string; supplierIds: string[] }

const TEMPLATE_ID = 'supplier_order_email'

export default function AdminOutsourcingPage() {
  const [rows, setRows] = useState<MaterialRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [productTypes, setProductTypes] = useState<ProductType[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Template editor state.
  const [tplBody, setTplBody] = useState('')
  const [tplLoaded, setTplLoaded] = useState('')
  const [tplSaving, setTplSaving] = useState(false)
  const [tplSavedAt, setTplSavedAt] = useState<number | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    // proof-viewer materials on the supplier route.
    const matP = supabase
      .from('materials')
      .select('id, display_name, category, outsourced_product_type, outsourced_supplier_ids')
      .eq('is_active', true)
      .eq('production_route', 'supplier')
      .order('category')
      .order('display_name')
    // Stock Control's live suppliers + product types (public schema, signed-in
    // SELECT is allowed by RLS).
    const supP = supabase.schema('public')
      .from('outsourced_suppliers')
      .select('id, name, email_addresses, is_international, active')
      .eq('active', true)
      .order('name')
    const ptP = supabase.schema('public')
      .from('outsourced_product_types')
      .select('id, name, active')
      .eq('active', true)
      .order('sort_order')
    const tplP = supabase.from('reply_templates').select('body').eq('id', TEMPLATE_ID).maybeSingle()

    const [matRes, supRes, ptRes, tplRes] = await Promise.all([matP, supP, ptP, tplP])
    setLoading(false)
    const firstErr = matRes.error || supRes.error || ptRes.error
    if (firstErr) { setError(firstErr.message); return }

    const list = (matRes.data ?? []) as MaterialRow[]
    setRows(list)
    setSuppliers(((supRes.data ?? []) as { id: string; name: string; email_addresses: string[] | null; is_international: boolean }[])
      .map((s) => ({ id: s.id, name: s.name, email: Array.isArray(s.email_addresses) && s.email_addresses.length ? s.email_addresses[0] : null, is_international: !!s.is_international })))
    setProductTypes(((ptRes.data ?? []) as ProductType[]))
    setDrafts(Object.fromEntries(list.map((r) => [r.id, {
      productType: r.outsourced_product_type ?? '',
      supplierIds: Array.isArray(r.outsourced_supplier_ids) ? [...r.outsourced_supplier_ids] : [],
    }])))
    const body = (tplRes.data as { body?: string } | null)?.body ?? DEFAULT_BODIES[TEMPLATE_ID] ?? ''
    setTplBody(body)
    setTplLoaded(body)
  }

  const rowState = useMemo(() => rows.map((r) => {
    const d = drafts[r.id] ?? { productType: '', supplierIds: [] }
    const savedIds = Array.isArray(r.outsourced_supplier_ids) ? r.outsourced_supplier_ids : []
    const dirty = d.productType !== (r.outsourced_product_type ?? '') ||
      d.supplierIds.length !== savedIds.length ||
      d.supplierIds.some((id) => !savedIds.includes(id))
    return { row: r, draft: d, dirty }
  }), [rows, drafts])

  const dirtyCount = rowState.filter((s) => s.dirty).length
  const saveDisabled = saving || dirtyCount === 0

  function setDraft(id: string, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
    if (savedAt != null) setSavedAt(null)
  }
  function toggleSupplier(id: string, supplierId: string) {
    setDrafts((d) => {
      const cur = d[id]?.supplierIds ?? []
      const next = cur.includes(supplierId) ? cur.filter((x) => x !== supplierId) : [...cur, supplierId]
      return { ...d, [id]: { ...d[id], supplierIds: next } }
    })
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true); setError(null)
    const updates = rowState.filter((s) => s.dirty)
    const prev = rows
    setRows(rows.map((r) => {
      const u = updates.find((s) => s.row.id === r.id)
      return u ? { ...r, outsourced_product_type: u.draft.productType || null, outsourced_supplier_ids: u.draft.supplierIds } : r
    }))
    const results = await Promise.all(updates.map((u) =>
      supabase.from('materials')
        .update({ outsourced_product_type: u.draft.productType || null, outsourced_supplier_ids: u.draft.supplierIds })
        .eq('id', u.row.id)))
    const firstError = results.find((r) => r.error)?.error ?? null
    if (firstError) { setRows(prev); setError(`Failed to save: ${firstError.message}`); setSaving(false); return }
    setSaving(false); setSavedAt(Date.now())
    void logAudit({
      action: 'material.outsourcing_updated',
      targetType: 'material',
      targetLabel: updates.length === 1 ? updates[0].row.display_name : `${updates.length} materials`,
      metadata: { changes: updates.map((u) => ({ material_id: u.row.id, material_display_name: u.row.display_name, product_type: u.draft.productType, supplier_ids: u.draft.supplierIds })) },
    })
  }

  async function handleTplSave() {
    if (tplSaving || tplBody === tplLoaded) return
    setTplSaving(true); setError(null)
    const { error: err } = await supabase.from('reply_templates')
      .update({ body: tplBody, updated_at: new Date().toISOString() })
      .eq('id', TEMPLATE_ID)
    setTplSaving(false)
    if (err) { setError(`Failed to save template: ${err.message}`); return }
    setTplLoaded(tplBody); setTplSavedAt(Date.now())
    void logAudit({ action: 'reply_template.updated', targetType: 'reply_template', targetId: TEMPLATE_ID, targetLabel: 'Supplier order email' })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000
  const tplRecentlySaved = tplSavedAt != null && Date.now() - tplSavedAt < 2000
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? '(unknown)'

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-ink">Outsourcing</h2>
        <p className="mt-1 text-sm text-ink-mute">
          For each supplier-made material, set the product type the supplier email states and which supplier(s) it can go to. Suppliers and product types are managed in Stock Control and read live here. One supplier is used automatically; with several, the person placing the order chooses.
        </p>
      </div>

      {error && <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 border-out">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20"><div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink" /></div>
      ) : (
        <>
          <div className="overflow-hidden rounded-[14px] bg-surface border border-line">
            <table className="min-w-full divide-y divide-line-soft">
              <thead>
                <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                  <th className="px-5 py-3">Material</th>
                  <th className="px-5 py-3">Product type (the “Material:” line)</th>
                  <th className="px-5 py-3">Allowed suppliers</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft text-sm">
                {rowState.map(({ row, draft, dirty }) => (
                  <tr key={row.id} className={dirty ? 'bg-low-soft/40' : ''}>
                    <td className="px-5 py-3 align-top">
                      <div className="font-medium text-ink">{row.display_name}</div>
                      <div className="text-xs uppercase tracking-wider text-ink-mute">{row.category}</div>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <select
                        value={draft.productType}
                        onChange={(e) => setDraft(row.id, { productType: e.target.value })}
                        className="h-[38px] w-full max-w-[240px] rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                      >
                        <option value="">— none —</option>
                        {productTypes.map((pt) => <option key={pt.id} value={pt.name}>{pt.name}</option>)}
                        {/* Preserve a stored value that no longer matches a live product type. */}
                        {draft.productType && !productTypes.some((pt) => pt.name === draft.productType) && (
                          <option value={draft.productType}>{draft.productType} (not in Stock Control)</option>
                        )}
                      </select>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <div className="space-y-1.5">
                        {suppliers.map((s) => (
                          <label key={s.id} className="flex items-center gap-2 text-sm text-ink">
                            <input type="checkbox" checked={draft.supplierIds.includes(s.id)} onChange={() => toggleSupplier(row.id, s.id)} className="h-4 w-4 rounded border-line" />
                            <span>{s.name}{s.is_international ? ' · intl' : ''}{s.email ? '' : ' · no email'}</span>
                          </label>
                        ))}
                        {/* Any stored supplier id not in the live active list (deactivated / removed in Stock Control). */}
                        {draft.supplierIds.filter((id) => !suppliers.some((s) => s.id === id)).map((id) => (
                          <label key={id} className="flex items-center gap-2 text-sm text-out">
                            <input type="checkbox" checked onChange={() => toggleSupplier(row.id, id)} className="h-4 w-4 rounded border-out" />
                            <span>{supplierName(id)} · not active in Stock Control — untick to remove</span>
                          </label>
                        ))}
                        {draft.supplierIds.length === 0 && <p className="text-xs text-out">No supplier — orders for this material can’t be placed until one is ticked.</p>}
                        {draft.supplierIds.length > 1 && <p className="text-xs text-ink-mute">Several allowed — the placer chooses on the review page.</p>}
                      </div>
                    </td>
                  </tr>
                ))}
                {rowState.length === 0 && (
                  <tr><td colSpan={3} className="px-5 py-6 text-center text-sm text-ink-mute">No supplier-route materials. Set a material’s production route to “supplier” in Materials first.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3">
            {recentlySaved && !saving && <span className="text-xs text-in-stock">Saved</span>}
            {saving && <span className="text-xs text-ink-mute">Saving…</span>}
            <button type="button" onClick={handleSave} disabled={saveDisabled}
              className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
              {dirtyCount === 0 ? 'Save routing' : `Save routing (${dirtyCount} ${dirtyCount === 1 ? 'material' : 'materials'})`}
            </button>
          </div>

          {/* ── Supplier email template ─────────────────────────────────── */}
          <div className="rounded-[14px] bg-surface border border-line p-5">
            <h3 className="text-base font-semibold text-ink">Supplier order email</h3>
            <p className="mt-1 text-sm text-ink-mute">
              The email sent to the supplier when an outsourced order is placed. <code className="rounded bg-canvas px-1">{'{customer}'}</code> is the customer name. <code className="rounded bg-canvas px-1">{'{order_details}'}</code> is the order spec (quantity, material, type, thickness, finish, must-ship-by, per-person split, artwork link) — keep it exactly as-is, it’s how Stock Control reads the order. Only edit the wording around it.
            </p>
            <textarea
              value={tplBody}
              onChange={(e) => { setTplBody(e.target.value); if (tplSavedAt != null) setTplSavedAt(null) }}
              rows={8}
              className="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
            />
            {!tplBody.includes('{order_details}') && (
              <p className="mt-1 text-xs text-out">Add back <code>{'{order_details}'}</code> — without it the supplier won’t get the order spec and Stock Control can’t import it.</p>
            )}
            <div className="mt-3 flex items-center justify-end gap-3">
              {tplRecentlySaved && !tplSaving && <span className="text-xs text-in-stock">Saved</span>}
              {tplSaving && <span className="text-xs text-ink-mute">Saving…</span>}
              <button type="button" onClick={() => { setTplBody(DEFAULT_BODIES[TEMPLATE_ID] ?? ''); if (tplSavedAt != null) setTplSavedAt(null) }}
                disabled={tplBody === (DEFAULT_BODIES[TEMPLATE_ID] ?? '')}
                className="rounded border border-line px-3 py-2 text-sm font-medium text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40">
                Reset to default
              </button>
              <button type="button" onClick={handleTplSave} disabled={tplSaving || tplBody === tplLoaded || !tplBody.includes('{order_details}')}
                className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                Save template
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
