import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import { PageDropOverlay } from '../components/PageDropOverlay'
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

interface Finish {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

interface PriceTierRow {
  material_variant_id: string
  quantity: number
  total_price: number
}

interface ImageEntry {
  localId: string
  file: File
  preview: string
  label: string
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png']
const MAX_IMAGES = 10

function defaultLabel(index: number): string {
  if (index === 0) return 'Front'
  if (index === 1) return 'Back'
  return `Image ${index + 1}`
}

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([])
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [variantSnapshots, setVariantSnapshots] = useState<Record<string, Record<number, string>>>({})
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
  const [inkNames, setInkNames] = useState('')
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [availableFinishes, setAvailableFinishes] = useState<Finish[]>([])
  const [selectedFinishes, setSelectedFinishes] = useState<string[]>([])
  const [imagesByFinish, setImagesByFinish] = useState<Record<string, ImageEntry[]>>({ '': [] })
  const [activeImageFinish, setActiveImageFinish] = useState('')
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [imagesError, setImagesError] = useState('')
  const [materialError, setMaterialError] = useState('')
  const [variantError, setVariantError] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fileRef         = useRef<HTMLInputElement>(null)
  const dragIndexRef    = useRef<number | null>(null)
  const imageSectionRef = useRef<HTMLElement>(null)
  const materialRef     = useRef<HTMLSelectElement>(null)
  const variantRef      = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!proofId) return
    supabase.from('proofs').select('contacts(full_name)').eq('id', proofId).single()
      .then(({ data }) => {
        const c = (data?.contacts as any)
        if (c) setProofName(c.full_name ?? '')
      })
    supabase.from('materials').select('id, display_name').eq('is_active', true).order('sort_order')
      .then(({ data }) => setMaterials((data ?? []) as Material[]))
  }, [proofId])

  useEffect(() => {
    setVariants([])
    setSelectedVariantIds([])
    setVariantTiers({})
    setVariantSnapshots({})
    setAvailableFinishes([])
    setSelectedFinishes([])
    setActiveImageFinish('')
    setImagesByFinish({ '': [] })
    if (!selectedMaterialId) return

    let cancelled = false

    async function load() {
      const [variantsResult, finishesResult] = await Promise.all([
        supabase.from('material_variants')
          .select('id, display_name, variant_type, sort_order')
          .eq('material_id', selectedMaterialId)
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('finishes')
          .select('id, code, display_name, is_base, sort_order')
          .eq('material_id', selectedMaterialId)
          .order('sort_order'),
      ])
      if (cancelled) return

      const v = (variantsResult.data ?? []) as Variant[]
      setVariants(v)
      if (v[0]?.variant_type === 'thickness') {
        setSelectedVariantIds(v.map((x) => x.id))
      } else if (v.length === 1) {
        setSelectedVariantIds([v[0].id])
      } else {
        setSelectedVariantIds([])
      }

      const finishes = (finishesResult.data ?? []) as Finish[]
      setAvailableFinishes(finishes)
      if (finishes.length > 0) {
        const base = finishes.find(f => f.is_base) ?? finishes[0]
        setSelectedFinishes([base.code])
        setActiveImageFinish(base.code)
        setImagesByFinish({ [base.code]: [] })
      }
    }

    load()
    return () => { cancelled = true }
  }, [selectedMaterialId])

  useEffect(() => {
    setVariantTiers({})
    setVariantSnapshots({})
    if (selectedVariantIds.length === 0 || currency === null) return

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

  // activeKey is the map key for the currently visible finish tab
  const hasFinishes = availableFinishes.length > 0
  const finishMode  = hasFinishes && selectedFinishes.length > 0
  const activeKey   = finishMode ? activeImageFinish : ''
  const currentImages = imagesByFinish[activeKey] ?? []

  function toggleFinish(code: string) {
    setSelectedFinishes(prev => {
      if (prev.includes(code)) {
        // Deselecting — revoke previews and remove from map
        setImagesByFinish(ibf => {
          const imgs = ibf[code] ?? []
          imgs.forEach(img => URL.revokeObjectURL(img.preview))
          const { [code]: _removed, ...rest } = ibf
          return rest
        })
        const next = prev.filter(c => c !== code)
        if (activeImageFinish === code) setActiveImageFinish(next[0] ?? '')
        return next
      } else {
        // Selecting — if entering finish mode for first time, migrate '' images
        setImagesByFinish(ibf => {
          if (prev.length === 0) {
            const { '': noFinishImgs = [], ...rest } = ibf
            return { ...rest, [code]: noFinishImgs }
          }
          return { ...ibf, [code]: [] }
        })
        if (prev.length === 0) setActiveImageFinish(code)
        return [...prev, code]
      }
    })
  }

  function addFiles(files: File[]) {
    setFileError('')
    setFileNote('')
    setImagesError('')
    if (files.length === 0) return

    // Filter to accepted image types (drops from desktop may include anything)
    const okByType = files.filter(f => ACCEPTED_TYPES.includes(f.type))
    const rejectedByType = files.length - okByType.length
    if (okByType.length === 0) {
      setFileError('Only image files can be added.')
      return
    }

    // 10 MB per-file size limit
    const okBySize = okByType.filter(f => f.size <= MAX_FILE_SIZE)
    const rejectedBySize = okByType.length - okBySize.length
    if (okBySize.length === 0) {
      setFileError('Each image must be 10 MB or smaller.')
      return
    }

    // 10-images-per-finish cap
    const remaining = MAX_IMAGES - currentImages.length
    if (remaining <= 0) {
      setFileNote(`Can't add more — ${MAX_IMAGES}-image limit reached.`)
      return
    }

    const toAdd = okBySize.slice(0, remaining)
    const rejectedByLimit = okBySize.length - toAdd.length

    const notes: string[] = []
    if (rejectedByLimit > 0) {
      notes.push(`Added ${toAdd.length}. ${rejectedByLimit} skipped (${MAX_IMAGES}-image limit reached).`)
    }
    if (rejectedByType > 0 || rejectedBySize > 0) {
      const reasons: string[] = []
      if (rejectedByType > 0) reasons.push(`${rejectedByType} non-image`)
      if (rejectedBySize > 0) reasons.push(`${rejectedBySize} over 10 MB`)
      notes.push(`Ignored: ${reasons.join(', ')}.`)
    }
    if (notes.length > 0) setFileNote(notes.join(' '))

    setImagesByFinish(prev => {
      const cur = prev[activeKey] ?? []
      const currentCount = cur.length
      return {
        ...prev,
        [activeKey]: [
          ...cur,
          ...toAdd.map((file, i) => ({
            localId: uuidv4(),
            file,
            preview: URL.createObjectURL(file),
            label: defaultLabel(currentCount + i),
          })),
        ],
      }
    })
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []))
    if (fileRef.current) fileRef.current.value = ''
  }

  const { isZoneDragOver, isPageDragOver, zoneProps } = useImageFileDrop({ onFiles: addFiles })

  function removeImage(localId: string) {
    setImagesByFinish(prev => {
      const cur = prev[activeKey] ?? []
      const removed = cur.find((e) => e.localId === localId)
      if (removed) URL.revokeObjectURL(removed.preview)
      return { ...prev, [activeKey]: cur.filter((e) => e.localId !== localId) }
    })
  }

  function updateLabel(localId: string, label: string) {
    setImagesByFinish(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(e => e.localId === localId ? { ...e, label } : e),
    }))
  }

  function handleDragStart(index: number) { dragIndexRef.current = index }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || from === index) return
    setImagesByFinish(prev => {
      const cur = [...(prev[activeKey] ?? [])]
      const [item] = cur.splice(from, 1)
      cur.splice(index, 0, item)
      return { ...prev, [activeKey]: cur }
    })
    dragIndexRef.current = index
  }

  function handleDragEnd() { dragIndexRef.current = null }

  function toggleVariant(variantId: string) {
    setVariantError('')
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
    setImagesError('')
    setMaterialError('')
    setVariantError('')

    // Validate images — each selected finish must have at least one image
    const finishKeys = finishMode ? selectedFinishes : ['']
    for (const fk of finishKeys) {
      if ((imagesByFinish[fk] ?? []).length === 0) {
        const finishName = fk === '' ? '' : availableFinishes.find(f => f.code === fk)?.display_name ?? fk
        setImagesError(
          finishName
            ? `Please add at least one image for ${finishName}.`
            : 'Please add at least one proof image.'
        )
        imageSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }

    if (!selectedMaterialId) {
      setMaterialError('Please select a material.')
      materialRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      materialRef.current?.focus()
      return
    }
    if (selectedVariantIds.length === 0) {
      setVariantError('Please select at least one variant.')
      variantRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    // Button is disabled until these are set, but narrow the types defensively.
    if (pricingDisplay === null || currency === null) return

    setSubmitting(true)

    // Flatten images across all finish tabs (in selectedFinishes order)
    const allEntries = finishKeys.flatMap(fk =>
      (imagesByFinish[fk] ?? []).map(entry => ({ entry, finish: fk === '' ? null : fk }))
    )

    const uploadResults = await Promise.all(
      allEntries.map(async ({ entry }) => {
        const ext = entry.file.type === 'image/png' ? 'png' : 'jpg'
        const path = `${proofId}/${uuidv4()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('proof-images')
          .upload(path, entry.file, { contentType: entry.file.type, upsert: false })
        return { path, error: uploadError }
      })
    )

    const failedUpload = uploadResults.find((r) => r.error)
    if (failedUpload) {
      const successPaths = uploadResults.filter((r) => !r.error).map((r) => r.path)
      if (successPaths.length > 0) await supabase.storage.from('proof-images').remove(successPaths)
      setError(`Image upload failed: ${failedUpload.error!.message}`)
      setSubmitting(false)
      return
    }

    const uploadedPaths = uploadResults.map((r) => r.path)
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

    const { data: versionData, error: insertError } = await supabase
      .from('proof_versions')
      .insert({
        proof_id: proofId,
        material_id: selectedMaterialId,
        material_display: material.display_name,
        ink_names: parsedInkNames,
        currency,
        pricing_snapshot: pricingSnapshot,
        change_notes: changeNotes.trim() || null,
        finishes: selectedFinishes,
        custom_quote: pricingDisplay === 'custom',
      })
      .select('id')
      .single()

    if (insertError || !versionData) {
      await supabase.storage.from('proof-images').remove(uploadedPaths)
      setError(`Failed to save version: ${insertError?.message ?? 'Unknown error'}`)
      setSubmitting(false)
      return
    }

    const imageInserts = allEntries.map(({ entry, finish }, i) => {
      const finishKey = finish ?? ''
      const sortOrder = (imagesByFinish[finishKey] ?? []).findIndex(e => e.localId === entry.localId)
      return {
        proof_version_id: versionData.id,
        image_path: uploadedPaths[i],
        label: entry.label,
        sort_order: sortOrder,
        finish,
        original_filename: entry.file.name,
      }
    })

    const { error: imgInsertError } = await supabase.from('proof_version_images').insert(imageInserts)

    if (imgInsertError) {
      await supabase.from('proof_versions').delete().eq('id', versionData.id)
      await supabase.storage.from('proof-images').remove(uploadedPaths)
      setError(`Failed to save images: ${imgInsertError.message}`)
      setSubmitting(false)
      return
    }

    navigate(`/proofs/${proofId}`)
  }

  const variantType = variants[0]?.variant_type
  const isThickness = variantType === 'thickness'

  // Save-button gating — both the pricing-display choice and the currency must be
  // set before the button enables. Messaging prefers the most specific reason.
  const canSave = pricingDisplay !== null && currency !== null
  const disabledReason = canSave
    ? undefined
    : pricingDisplay === null && currency === null
      ? 'Complete required fields to save'
      : pricingDisplay === null
        ? 'Choose a pricing display option to save'
        : 'Choose a currency to save'

  return (
    <div className="min-h-screen bg-gray-50">
      <PageDropOverlay visible={isPageDragOver} />
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to proof</Link>
        </div>

        {/* Page heading + actions */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Add version</h1>
            {proofName && <p className="mt-1 text-gray-500">{proofName}</p>}
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={`/proofs/${proofId}`}
              className="text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              Cancel
            </Link>
            <button
              type="submit"
              form="new-version-form"
              disabled={submitting || !canSave}
              title={disabledReason}
              aria-label={disabledReason}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Uploading and saving…' : 'Save version'}
            </button>
          </div>
        </div>

        <form id="new-version-form" onSubmit={handleSubmit} className="space-y-6">

          {/* Image upload */}
          <section ref={imageSectionRef} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">
              Proof images
              {currentImages.length > 0 && (
                <span className="ml-2 font-normal normal-case text-gray-400">— drag to reorder</span>
              )}
            </h2>

            {/* Finish tabs */}
            {finishMode && selectedFinishes.length > 0 && (
              <div className="mb-4 flex gap-0 border-b border-gray-100">
                {selectedFinishes.map(fCode => {
                  const f = availableFinishes.find(x => x.code === fCode)
                  const isActive = activeImageFinish === fCode
                  return (
                    <button
                      key={fCode}
                      type="button"
                      onClick={() => setActiveImageFinish(fCode)}
                      className={[
                        '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'border-gray-900 text-gray-900'
                          : 'border-transparent text-gray-400 hover:text-gray-700',
                      ].join(' ')}
                    >
                      {f?.display_name ?? fCode}
                      <span className={['ml-1.5 text-xs', isActive ? 'text-gray-400' : 'text-gray-300'].join(' ')}>
                        ({(imagesByFinish[fCode] ?? []).length})
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {currentImages.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {currentImages.map((entry, index) => (
                  <div
                    key={entry.localId}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                    className="group relative cursor-grab rounded-xl border border-gray-200 bg-gray-50 p-2 active:cursor-grabbing"
                  >
                    <img
                      src={entry.preview}
                      alt={entry.label}
                      className="mb-2 aspect-square w-full rounded-lg object-contain"
                    />
                    <input
                      type="text"
                      value={entry.label}
                      onChange={(e) => updateLabel(entry.localId, e.target.value)}
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                      placeholder="Label"
                    />
                    <p
                      className="mt-1 truncate text-[11px] text-gray-400"
                      title={entry.file.name}
                    >
                      {entry.file.name}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeImage(entry.localId)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {currentImages.length < MAX_IMAGES && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  {...zoneProps}
                  className={[
                    'flex w-full items-center justify-center rounded-xl border-2 py-8 text-sm transition-colors',
                    isZoneDragOver
                      ? 'border-solid border-gray-900 bg-gray-50 text-gray-900'
                      : imagesError
                        ? 'border-dashed border-red-300 text-red-400 hover:border-red-400 hover:text-red-600'
                        : 'border-dashed border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600',
                  ].join(' ')}
                >
                  {isZoneDragOver
                    ? 'Drop to add images'
                    : currentImages.length === 0
                      ? 'Click or drop to upload JPEG or PNG (max 10 MB each)'
                      : `Add more images (${currentImages.length} / ${MAX_IMAGES})`}
                </button>
              </>
            )}

            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
            {fileNote && <p className="mt-2 text-sm text-gray-500">{fileNote}</p>}
            {imagesError && <p className="mt-2 text-sm text-red-600">{imagesError}</p>}
          </section>

          {/* Pricing display — required choice between standard grid and custom quote */}
          <PricingDisplayField value={pricingDisplay} onChange={setPricingDisplay} />

          {/* Material + variant + finishes selection */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material</label>
              <select
                ref={materialRef}
                value={selectedMaterialId}
                onChange={(e) => { setSelectedMaterialId(e.target.value); setMaterialError('') }}
                className={[selectClass, materialError ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : ''].join(' ')}
              >
                <option value="">Select a material…</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
              {materialError && <p className="mt-1.5 text-sm text-red-600">{materialError}</p>}
            </div>

            {variants.length > 0 && variantType !== 'default' && (
              <div ref={variantRef} className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  {variantLabel(variantType)}
                  {isThickness && <span className="ml-2 font-normal text-gray-400">— select all to expose on the proof</span>}
                </label>

                {isThickness ? (
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
                  <select
                    value={selectedVariantIds[0] ?? ''}
                    onChange={(e) => { setSelectedVariantIds(e.target.value ? [e.target.value] : []); setVariantError('') }}
                    className={[selectClass, variantError ? 'border-red-400' : ''].join(' ')}
                  >
                    <option value="">Select…</option>
                    {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                  </select>
                )}
                {variantError && <p className="mt-1.5 text-sm text-red-600">{variantError}</p>}
              </div>
            )}

            {/* Finish selection — only for materials that support finishes (Steel, Gold) */}
            {hasFinishes && (
              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">Finishes</label>
                <div className="flex flex-wrap gap-2">
                  {availableFinishes.map(f => {
                    const selected = selectedFinishes.includes(f.code)
                    return (
                      <button
                        key={f.code}
                        type="button"
                        onClick={() => toggleFinish(f.code)}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium ring-1 transition-colors',
                          selected
                            ? 'bg-gray-900 text-white ring-gray-900'
                            : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50',
                        ].join(' ')}
                      >
                        {f.display_name}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1.5 text-xs text-gray-400">
                  Select which finishes to offer. Each finish gets its own proof images.
                </p>
              </div>
            )}

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
              <CurrencyField value={currency} onChange={setCurrency} />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
              </label>
              <input type="text" placeholder="e.g. Pantone 185 C, Metallic Gold" value={inkNames}
                onChange={(e) => setInkNames(e.target.value)} className={inputClass} />
            </div>

          </section>

          {/* Pricing — one section per selected variant. Hidden until a currency is picked. */}
          {selectedVariantIds.length > 0 && currency !== null && selectedVariantIds.map((vid) => {
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
