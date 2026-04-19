import { useEffect, useState, useRef, type FormEvent, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'

interface Material {
  id: string
  code: string
  display_name: string
}

interface Variant {
  id: string
  code: string
  display_name: string
  variant_type: string
  sort_order: number
}

interface PriceTier {
  quantity: number
  total_price: number
}

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png']

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState('')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [priceTiers, setPriceTiers] = useState<PriceTier[]>([])
  // Editable snapshot: qty → price string (allows user overrides)
  const [snapshot, setSnapshot] = useState<Record<number, string>>({})
  const [inkNames, setInkNames] = useState('')
  const [changeNotes, setChangeNotes] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Load proof name + materials on mount
  useEffect(() => {
    if (!proofId) return
    supabase.from('proofs').select('customer_name').eq('id', proofId).single()
      .then(({ data }) => { if (data) setProofName(data.customer_name) })

    supabase.from('materials')
      .select('id, code, display_name')
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => setMaterials((data ?? []) as Material[]))
  }, [proofId])

  // Load variants when material changes
  useEffect(() => {
    setSelectedVariantId('')
    setVariants([])
    setPriceTiers([])
    setSnapshot({})
    if (!selectedMaterialId) return

    supabase.from('material_variants')
      .select('id, code, display_name, variant_type, sort_order')
      .eq('material_id', selectedMaterialId)
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        const v = (data ?? []) as Variant[]
        setVariants(v)
        // Auto-select if only one variant (e.g. default type)
        if (v.length === 1) setSelectedVariantId(v[0].id)
      })
  }, [selectedMaterialId])

  // Load price tiers when variant + currency changes
  useEffect(() => {
    setPriceTiers([])
    setSnapshot({})
    if (!selectedVariantId) return

    supabase.from('price_tiers')
      .select('quantity, total_price')
      .eq('material_variant_id', selectedVariantId)
      .eq('currency', currency)
      .order('quantity')
      .then(({ data }) => {
        const tiers = (data ?? []) as PriceTier[]
        setPriceTiers(tiers)
        const snap: Record<number, string> = {}
        tiers.forEach((t) => { snap[t.quantity] = String(t.total_price) })
        setSnapshot(snap)
      })
  }, [selectedVariantId, currency])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFileError('')
    const file = e.target.files?.[0]
    if (!file) return

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setFileError('Only JPEG and PNG files are accepted.')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError('File must be 10 MB or smaller.')
      return
    }

    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!imageFile) { setError('Please select a proof image.'); return }
    if (!selectedMaterialId) { setError('Please select a material.'); return }
    if (!selectedVariantId) { setError('Please select a variant.'); return }

    setSubmitting(true)

    // Upload image
    const imagePath = `${proofId}/${uuidv4()}.jpg`
    const { error: uploadError } = await supabase.storage
      .from('proof-images')
      .upload(imagePath, imageFile, { contentType: imageFile.type, upsert: false })

    if (uploadError) {
      setError(`Image upload failed: ${uploadError.message}`)
      setSubmitting(false)
      return
    }

    // Build snapshot from editable rows
    const pricingSnapshot: Record<string, number> = {}
    Object.entries(snapshot).forEach(([qty, price]) => {
      const parsed = parseFloat(price)
      if (!isNaN(parsed)) pricingSnapshot[qty] = parsed
    })

    // Resolve display names
    const material = materials.find((m) => m.id === selectedMaterialId)!
    const variant = variants.find((v) => v.id === selectedVariantId)!
    const variantDisplay = variant.variant_type === 'default' ? 'Default' : variant.display_name

    const parsedInkNames = inkNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const { error: insertError } = await supabase.from('proof_versions').insert({
      proof_id: proofId,
      image_path: imagePath,
      material_variant_id: selectedVariantId,
      material_display: material.display_name,
      variant_display: variantDisplay,
      ink_names: parsedInkNames,
      currency,
      pricing_snapshot: pricingSnapshot,
      change_notes: changeNotes.trim() || null,
    })

    if (insertError) {
      // If insert fails, clean up the uploaded image
      await supabase.storage.from('proof-images').remove([imagePath])
      setError(`Failed to save version: ${insertError.message}`)
      setSubmitting(false)
      return
    }

    navigate(`/proofs/${proofId}`)
  }



  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">
            ← Back to proof
          </Link>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-gray-900">Add version</h1>
        {proofName && <p className="mb-8 text-gray-500">{proofName}</p>}

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Image upload */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Proof image</h2>

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              onChange={handleFileChange}
              className="hidden"
            />

            {imagePreview ? (
              <div className="relative">
                <img src={imagePreview} alt="Preview" className="w-full rounded-xl object-contain" />
                <button
                  type="button"
                  onClick={() => { setImageFile(null); setImagePreview(''); if (fileRef.current) fileRef.current.value = '' }}
                  className="absolute right-2 top-2 rounded-full bg-white px-2 py-1 text-xs text-gray-600 shadow hover:bg-gray-50"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex w-full items-center justify-center rounded-xl border-2 border-dashed border-gray-200 py-12 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600"
              >
                Click to upload JPEG or PNG (max 10 MB)
              </button>
            )}

            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
          </section>

          {/* Material + variant */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material</label>
              <select
                value={selectedMaterialId}
                onChange={(e) => setSelectedMaterialId(e.target.value)}
                className={selectClass}
              >
                <option value="">Select a material…</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name}</option>
                ))}
              </select>
            </div>

            {variants.length > 0 && variants[0]?.variant_type !== 'default' && (
              <div className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  {variantLabel(variants[0]?.variant_type)}
                </label>
                <select
                  value={selectedVariantId}
                  onChange={(e) => setSelectedVariantId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select…</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.display_name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                className={selectClass}
              >
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Pantone 185 C, Metallic Gold"
                value={inkNames}
                onChange={(e) => setInkNames(e.target.value)}
                className={inputClass}
              />
            </div>
          </section>

          {/* Pricing */}
          {priceTiers.length > 0 && (
            <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">Pricing</h2>
              <p className="mb-4 text-xs text-gray-400">Pre-filled from live pricing. Edit any value to override.</p>

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
                    <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total ({currency})</th>
                    <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
                  </tr>
                </thead>
                <tbody>
                  {priceTiers.map((tier) => {
                    const overrideVal = snapshot[tier.quantity] ?? ''
                    const parsed = parseFloat(overrideVal)
                    return (
                      <tr key={tier.quantity} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-4 font-medium text-gray-900">{tier.quantity.toLocaleString()}</td>
                        <td className="py-2 pr-4">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={overrideVal}
                            onChange={(e) => setSnapshot((prev) => ({ ...prev, [tier.quantity]: e.target.value }))}
                            className="w-28 rounded border border-gray-200 px-2 py-1 text-sm focus:border-gray-900 focus:outline-none"
                          />
                        </td>
                        <td className="py-2 text-gray-500 text-xs">
                          {!isNaN(parsed) && parsed > 0
                            ? formatPrice(parsed / tier.quantity, currency, 2)
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* Change notes */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Change notes</h2>
            <textarea
              rows={3}
              placeholder="What changed in this version? Shown to the customer."
              value={changeNotes}
              onChange={(e) => setChangeNotes(e.target.value)}
              className={inputClass}
            />
          </section>

          {error && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? 'Uploading and saving…' : 'Save version'}
          </button>
        </form>
      </div>
    </div>
  )
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
