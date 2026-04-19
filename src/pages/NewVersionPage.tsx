import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'

interface Material {
  id: string
  display_name: string
}

interface Variant {
  id: string
  display_name: string
  variant_type: string
  sort_order: number
}

interface PriceTierRow {
  material_variant_id: string
  quantity: number
  total_price: number
}

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']
const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png']

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  // For thickness: multiple selections; for others: single selection (array of one)
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([])
  const [currency, setCurrency] = useState<Currency>('GBP')
  // variantId → { quantity → price string }
  const [variantSnapshots, setVariantSnapshots] = useState<Record<string, Record<number, string>>>({})
  // variantId → sorted PriceTierRow[]
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
  const [inkNames, setInkNames] = useState('')
  const [changeNotes, setChangeNotes] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!proofId) return
    supabase.from('proofs').select('customer_name').eq('id', proofId).single()
      .then(({ data }) => { if (data) setProofName(data.customer_name) })
    supabase.from('materials').select('id, display_name').eq('is_active', true).order('sort_order')
      .then(({ data }) => setMaterials((data ?? []) as Material[]))
  }, [proofId])

  // Load variants when material changes
  useEffect(() => {
    setVariants([])
    setSelectedVariantIds([])
    setVariantTiers({})
    setVariantSnapshots({})
    if (!selectedMaterialId) return

    supabase.from('material_variants')
      .select('id, display_name, variant_type, sort_order')
      .eq('material_id', selectedMaterialId)
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        const v = (data ?? []) as Variant[]
        setVariants(v)
        if (v[0]?.variant_type === 'thickness') {
          // Default: all thickness variants selected
          setSelectedVariantIds(v.map((x) => x.id))
        } else if (v.length === 1) {
          // Single variant (default type) — auto-select
          setSelectedVariantIds([v[0].id])
        } else {
          setSelectedVariantIds([])
        }
      })
  }, [selectedMaterialId])

  // Load price tiers whenever selection or currency changes
  useEffect(() => {
    setVariantTiers({})
    setVariantSnapshots({})
    if (selectedVariantIds.length === 0) return

    supabase.from('price_tiers')
      .select('material_variant_id, quantity, total_price')
      .in('material_variant_id', selectedVariantIds)
      .eq('currency', currency)
      .order('quantity')
      .then(({ data }) => {
        const rows = (data ?? []) as PriceTierRow[]
        const tiersMap: Record<string, PriceTierRow[]> = {}
        const snapMap: Record<string, Record<number, string>> = {}
        rows.forEach((r) => {
          if (!tiersMap[r.material_variant_id]) tiersMap[r.material_variant_id] = []
          tiersMap[r.material_variant_id].push(r)
          if (!snapMap[r.material_variant_id]) snapMap[r.material_variant_id] = {}
          snapMap[r.material_variant_id][r.quantity] = String(r.total_price)
        })
        setVariantTiers(tiersMap)
        setVariantSnapshots(snapMap)
      })
  }, [selectedVariantIds, currency])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFileError('')
    const file = e.target.files?.[0]
    if (!file) return
    if (!ACCEPTED_TYPES.includes(file.type)) { setFileError('Only JPEG and PNG files are accepted.'); return }
    if (file.size > MAX_FILE_SIZE) { setFileError('File must be 10 MB or smaller.'); return }
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  function toggleVariant(variantId: string) {
    setSelectedVariantIds((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    )
  }

  function updatePrice(variantId: string, qty: number, value: string) {
    setVariantSnapshots((prev) => ({
      ...prev,
      [variantId]: { ...prev[variantId], [qty]: value },
    }))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')

    if (!imageFile) { setError('Please select a proof image.'); return }
    if (!selectedMaterialId) { setError('Please select a material.'); return }
    if (selectedVariantIds.length === 0) { setError('Please select at least one variant.'); return }

    setSubmitting(true)

    const imagePath = `${proofId}/${uuidv4()}.jpg`
    const { error: uploadError } = await supabase.storage
      .from('proof-images')
      .upload(imagePath, imageFile, { contentType: imageFile.type, upsert: false })

    if (uploadError) {
      setError(`Image upload failed: ${uploadError.message}`)
      setSubmitting(false)
      return
    }

    const material = materials.find((m) => m.id === selectedMaterialId)!

    const pricingSnapshot = {
      variants: selectedVariantIds.map((vid) => {
        const variant = variants.find((v) => v.id === vid)!
        const display = variant.variant_type === 'default' ? 'Default' : variant.display_name
        const prices: Record<string, number> = {}
        Object.entries(variantSnapshots[vid] ?? {}).forEach(([qty, price]) => {
          const parsed = parseFloat(price)
          if (!isNaN(parsed)) prices[qty] = parsed
        })
        return { variant_id: vid, display, prices }
      }),
    }

    const parsedInkNames = inkNames.split(',').map((s) => s.trim()).filter(Boolean)

    const { error: insertError } = await supabase.from('proof_versions').insert({
      proof_id: proofId,
      image_path: imagePath,
      material_id: selectedMaterialId,
      material_display: material.display_name,
      ink_names: parsedInkNames,
      currency,
      pricing_snapshot: pricingSnapshot,
      change_notes: changeNotes.trim() || null,
    })

    if (insertError) {
      await supabase.storage.from('proof-images').remove([imagePath])
      setError(`Failed to save version: ${insertError.message}`)
      setSubmitting(false)
      return
    }

    navigate(`/proofs/${proofId}`)
  }

  const variantType = variants[0]?.variant_type
  const isThickness = variantType === 'thickness'

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to proof</Link>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-gray-900">Add version</h1>
        {proofName && <p className="mb-8 text-gray-500">{proofName}</p>}

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Image upload */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Proof image</h2>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png" onChange={handleFileChange} className="hidden" />
            {imagePreview ? (
              <div className="relative">
                <img src={imagePreview} alt="Preview" className="w-full rounded-xl object-contain" />
                <button type="button" onClick={() => { setImageFile(null); setImagePreview(''); if (fileRef.current) fileRef.current.value = '' }}
                  className="absolute right-2 top-2 rounded-full bg-white px-2 py-1 text-xs text-gray-600 shadow hover:bg-gray-50">
                  Remove
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()}
                className="flex w-full items-center justify-center rounded-xl border-2 border-dashed border-gray-200 py-12 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600">
                Click to upload JPEG or PNG (max 10 MB)
              </button>
            )}
            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
          </section>

          {/* Material + variant selection */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material</label>
              <select value={selectedMaterialId} onChange={(e) => setSelectedMaterialId(e.target.value)} className={selectClass}>
                <option value="">Select a material…</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            </div>

            {variants.length > 0 && variantType !== 'default' && (
              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  {variantLabel(variantType)}
                  {isThickness && <span className="ml-2 font-normal text-gray-400">— select all to expose on the proof</span>}
                </label>

                {isThickness ? (
                  // Multi-select chips for thickness
                  <div className="flex flex-wrap gap-2">
                    {variants.map((v) => {
                      const checked = selectedVariantIds.includes(v.id)
                      return (
                        <button key={v.id} type="button" onClick={() => toggleVariant(v.id)}
                          className={[
                            'rounded-full px-4 py-1.5 text-sm font-medium ring-1 transition-colors',
                            checked
                              ? 'bg-gray-900 text-white ring-gray-900'
                              : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50',
                          ].join(' ')}>
                          {v.display_name}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  // Single select for ink_count / finish
                  <select value={selectedVariantIds[0] ?? ''} onChange={(e) => setSelectedVariantIds(e.target.value ? [e.target.value] : [])} className={selectClass}>
                    <option value="">Select…</option>
                    {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                  </select>
                )}
              </div>
            )}

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} className={selectClass}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
              </label>
              <input type="text" placeholder="e.g. Pantone 185 C, Metallic Gold" value={inkNames}
                onChange={(e) => setInkNames(e.target.value)} className={inputClass} />
            </div>
          </section>

          {/* Pricing — one section per selected variant */}
          {selectedVariantIds.length > 0 && selectedVariantIds.map((vid) => {
            const variant = variants.find((v) => v.id === vid)
            const tiers = variantTiers[vid] ?? []
            const snap = variantSnapshots[vid] ?? {}
            if (!variant) return null
            return (
              <section key={vid} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing — {variantType === 'default' ? material_display_for(selectedMaterialId, materials) : variant.display_name}
                </h2>
                <p className="mb-4 text-xs text-gray-400">
                  {tiers.length > 0 ? 'Pre-filled from live pricing. Edit any value to override.' : 'No price tiers found for this variant and currency.'}
                </p>
                {tiers.length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
                        <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total ({currency})</th>
                        <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tiers.map((tier) => {
                        const val = snap[tier.quantity] ?? ''
                        const parsed = parseFloat(val)
                        return (
                          <tr key={tier.quantity} className="border-b border-gray-50 last:border-0">
                            <td className="py-2 pr-4 font-medium text-gray-900">{tier.quantity.toLocaleString()}</td>
                            <td className="py-2 pr-4">
                              <input type="number" step="0.01" min="0" value={val}
                                onChange={(e) => updatePrice(vid, tier.quantity, e.target.value)}
                                className="w-28 rounded border border-gray-200 px-2 py-1 text-sm focus:border-gray-900 focus:outline-none" />
                            </td>
                            <td className="py-2 text-xs text-gray-500">
                              {!isNaN(parsed) && parsed > 0 ? formatPrice(parsed / tier.quantity, currency, 2) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </section>
            )
          })}

          {/* Change notes */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Change notes</h2>
            <textarea rows={3} placeholder="What changed in this version? Shown to the customer."
              value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} className={inputClass} />
          </section>

          {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

          <button type="submit" disabled={submitting}
            className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50">
            {submitting ? 'Uploading and saving…' : 'Save version'}
          </button>
        </form>
      </div>
    </div>
  )
}

function material_display_for(id: string, materials: Material[]) {
  return materials.find((m) => m.id === id)?.display_name ?? ''
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
const selectClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 bg-white'

function variantLabel(variantType?: string): string {
  switch (variantType) {
    case 'thickness': return 'Thickness'
    case 'ink_count': return 'Ink count'
    case 'finish': return 'Finish'
    default: return 'Variant'
  }
}
