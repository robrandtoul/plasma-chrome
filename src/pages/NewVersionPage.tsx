import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { formatPrice } from '../lib/currency'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { pluralLabel, variantLabel } from '../lib/labels'
import { DEFAULT_FEATURED_QUANTITIES } from '../lib/constants'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import { PageDropOverlay } from '../components/PageDropOverlay'
import type { Currency } from '../lib/types'

interface Material {
  id: string
  display_name: string
  requires_ink_names: boolean
  option_label: string | null
  featured_quantities: number[] | null
  multi_variant: boolean
}

interface Variant {
  id: string
  display_name: string
  variant_type: string
  sort_order: number
  ink_count: number | null
}

interface MaterialOption {
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
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

function defaultLabel(index: number): string {
  if (index === 0) return 'Front'
  if (index === 1) return 'Back'
  return `Image ${index + 1}`
}

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [proofCompany, setProofCompany] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([])
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [variantSnapshots, setVariantSnapshots] = useState<Record<string, Record<number, string>>>({})
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({})
  // Two separate ink states so each form path (free-text vs per-ink) keeps
  // typing feel. They only cross over when the designer switches materials
  // between the "requires per-ink names" set and everything else.
  const [inkNamesText, setInkNamesText] = useState('')
  const [inkNamesArray, setInkNamesArray] = useState<string[]>([])
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [imagesByOption, setImagesByOption] = useState<Record<string, ImageEntry[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [validationToast, setValidationToast] = useState('')

  const fileRef             = useRef<HTMLInputElement>(null)
  const dragIndexRef        = useRef<number | null>(null)
  const imageSectionRef     = useRef<HTMLElement | null>(null)
  const pricingDisplayRef   = useRef<HTMLElement | null>(null)
  const materialRef         = useRef<HTMLSelectElement>(null)
  const variantRef          = useRef<HTMLDivElement>(null)
  const currencyRef         = useRef<HTMLDivElement>(null)
  const inkNamesRef         = useRef<HTMLDivElement>(null)
  const toastTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!proofId) return
    supabase.from('proofs').select('contacts(full_name, companies(name))').eq('id', proofId).single()
      .then(({ data }) => {
        const c = (data?.contacts as any)
        if (c) {
          setProofName(c.full_name ?? '')
          setProofCompany(c.companies?.name ?? '')
        }
      })
    supabase.from('materials').select('id, display_name, requires_ink_names, option_label, featured_quantities, multi_variant').eq('is_active', true).order('sort_order')
      .then(({ data }) => setMaterials((data ?? []) as Material[]))

    // Pre-fill the pricing display + currency from admin-configured
    // defaults. Either column may be null ("no default") — in that case
    // we leave the picker unselected so the designer has to pick
    // explicitly before saving.
    supabase.from('settings')
      .select('default_pricing_display, default_currency')
      .eq('id', 1)
      .single()
      .then(({ data }) => {
        if (!data) return
        if (data.default_pricing_display != null) {
          setPricingDisplay((data.default_pricing_display === 'custom_quote' ? 'custom' : 'standard') as PricingDisplayValue)
        }
        if (data.default_currency != null) {
          setCurrency(data.default_currency as Currency)
        }
      })
  }, [proofId])

  useEffect(() => {
    setVariants([])
    setSelectedVariantIds([])
    setVariantTiers({})
    setVariantSnapshots({})
    setAvailableOptions([])
    setSelectedOptions([])
    setActiveImageOption('')
    setImagesByOption({ '': [] })
    if (!selectedMaterialId) return

    let cancelled = false

    async function load() {
      const [variantsResult, optionsResult] = await Promise.all([
        supabase.from('material_variants')
          .select('id, display_name, variant_type, sort_order, ink_count')
          .eq('material_id', selectedMaterialId)
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('material_options')
          .select('id, code, display_name, is_base, sort_order')
          .eq('material_id', selectedMaterialId)
          .order('sort_order'),
      ])
      if (cancelled) return

      const v = (variantsResult.data ?? []) as Variant[]
      setVariants(v)
      const pickedMaterial = materials.find((m) => m.id === selectedMaterialId)
      if (pickedMaterial?.multi_variant) {
        setSelectedVariantIds(v.map((x) => x.id))
      } else if (v.length === 1) {
        setSelectedVariantIds([v[0].id])
      } else {
        setSelectedVariantIds([])
      }

      const options = (optionsResult.data ?? []) as MaterialOption[]
      setAvailableOptions(options)
      if (options.length > 0) {
        const base = options.find(o => o.is_base) ?? options[0]
        setSelectedOptions([base.code])
        setActiveImageOption(base.code)
        setImagesByOption({ [base.code]: [] })
      }
    }

    load()
    return () => { cancelled = true }
  }, [selectedMaterialId])

  useEffect(() => {
    setVariantTiers({})
    setVariantSnapshots({})
    setExpandedVariants({})
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
  const hasOptions = availableOptions.length > 0
  const optionMode  = hasOptions && selectedOptions.length > 0
  const activeKey   = optionMode ? activeImageOption : ''
  const currentImages = imagesByOption[activeKey] ?? []

  function toggleOption(code: string) {
    setSelectedOptions(prev => {
      if (prev.includes(code)) {
        // Deselecting — revoke previews and remove from map
        setImagesByOption(ibf => {
          const imgs = ibf[code] ?? []
          imgs.forEach(img => URL.revokeObjectURL(img.preview))
          const { [code]: _removed, ...rest } = ibf
          return rest
        })
        const next = prev.filter(c => c !== code)
        if (activeImageOption === code) setActiveImageOption(next[0] ?? '')
        return next
      } else {
        // Selecting — if entering finish mode for first time, migrate '' images
        setImagesByOption(ibf => {
          if (prev.length === 0) {
            const { '': noFinishImgs = [], ...rest } = ibf
            return { ...rest, [code]: noFinishImgs }
          }
          return { ...ibf, [code]: [] }
        })
        if (prev.length === 0) setActiveImageOption(code)
        return [...prev, code]
      }
    })
  }

  function addFiles(files: File[]) {
    setFileError('')
    setFileNote('')
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

    setImagesByOption(prev => {
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
    setImagesByOption(prev => {
      const cur = prev[activeKey] ?? []
      const removed = cur.find((e) => e.localId === localId)
      if (removed) URL.revokeObjectURL(removed.preview)
      return { ...prev, [activeKey]: cur.filter((e) => e.localId !== localId) }
    })
  }

  function updateLabel(localId: string, label: string) {
    setImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(e => e.localId === localId ? { ...e, label } : e),
    }))
  }

  function handleDragStart(index: number) { dragIndexRef.current = index }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || from === index) return
    setImagesByOption(prev => {
      const cur = [...(prev[activeKey] ?? [])]
      const [item] = cur.splice(from, 1)
      cur.splice(index, 0, item)
      return { ...prev, [activeKey]: cur }
    })
    dragIndexRef.current = index
  }

  function handleDragEnd() { dragIndexRef.current = null }

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
    setSubmitAttempted(true)

    // Missing required fields: surface highlights + scroll to the first one in
    // document order. No save attempt, no network. Live validation clears the
    // highlights on the next render as each field becomes valid.
    if (!isValid) {
      const order: Array<{
        key: keyof typeof validations
        ref: React.RefObject<HTMLElement | null>
      }> = [
        { key: 'pricingDisplay', ref: pricingDisplayRef },
        { key: 'material',       ref: materialRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'variant',        ref: variantRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'currency',       ref: currencyRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'inkNames',       ref: inkNamesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'images',         ref: imageSectionRef },
      ]
      const first = order.find(o => !validations[o.key])
      first?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setValidationToast('Please complete all required fields to save')
      toastTimerRef.current = setTimeout(() => setValidationToast(''), 5000)
      return
    }

    // Button is still a submit-type, so narrow defensively even though
    // isValid guarantees these values.
    if (pricingDisplay === null) return

    setSubmitting(true)

    // Flatten images across all option tabs (in selectedOptions order)
    const optionKeys = optionMode ? selectedOptions : ['']
    const allEntries = optionKeys.flatMap(fk =>
      (imagesByOption[fk] ?? []).map(entry => ({ entry, option: fk === '' ? null : fk }))
    )

    const uploadResults = await Promise.all(
      allEntries.map(async ({ entry }) => {
        const path = `${proofId}/${uuidv4()}.jpg`
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

    // Ink names come from either the comma-separated text field (optional
    // materials) or the per-ink array (mandatory materials).
    const parsedInkNames: string[] = requiresInkNames
      ? inkNamesArray.slice(0, inkCount).map(s => s.trim())
      : inkNamesText.split(',').map(s => s.trim()).filter(Boolean)

    // The currency column is NOT NULL; default to GBP when the designer picked
    // Custom quote without explicitly selecting a currency. Value is not shown
    // to the customer in custom-quote mode.
    const currencyForInsert: Currency = currency ?? 'GBP'

    const { data: versionData, error: insertError } = await supabase
      .from('proof_versions')
      .insert({
        proof_id: proofId,
        material_id: selectedMaterialId,
        material_display: material.display_name,
        ink_names: parsedInkNames,
        currency: currencyForInsert,
        pricing_snapshot: pricingSnapshot,
        change_notes: changeNotes.trim() || null,
        material_options: selectedOptions,
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

    const imageInserts = allEntries.map(({ entry, option }, i) => {
      const optionKey = option ?? ''
      const sortOrder = (imagesByOption[optionKey] ?? []).findIndex(e => e.localId === entry.localId)
      return {
        proof_version_id: versionData.id,
        image_path: uploadedPaths[i],
        label: entry.label,
        sort_order: sortOrder,
        material_option: option,
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

    void logAudit({
      action: 'version.added',
      targetType: 'version',
      targetId: versionData.id,
      targetLabel: `${proofName || 'proof'} — ${material.display_name}`,
      metadata: {
        proof_id: proofId,
        material_id: selectedMaterialId,
        currency: currencyForInsert,
        image_count: imageInserts.length,
        custom_quote: pricingDisplay === 'custom',
      },
    })

    navigate(`/proofs/${proofId}`)
  }

  const variantType = variants[0]?.variant_type
  const isCustomQuote = pricingDisplay === 'custom'

  const selectedMaterial = materials.find(m => m.id === selectedMaterialId)
  const isMultiVariant = selectedMaterial?.multi_variant ?? false
  const requiresInkNames = selectedMaterial?.requires_ink_names ?? false

  // Option dimension label — singular ("Finish"/"Species") for in-copy use,
  // plural ("Finishes"/"Species") for the section heading.
  const optionLabelSingular = selectedMaterial?.option_label ?? 'Finish'
  const optionLabelPlural   = pluralLabel(optionLabelSingular)
  const selectedVariant = variants.find(v => v.id === selectedVariantIds[0])
  const inkCount = requiresInkNames ? (selectedVariant?.ink_count ?? 0) : 0
  const variantRequired = !isCustomQuote || requiresInkNames

  // Per-ink-field validity (for the requires-ink-names path). Empty slots fail.
  const inkNameValidities = requiresInkNames && inkCount > 0
    ? Array.from({ length: inkCount }, (_, i) => (inkNamesArray[i] ?? '').trim() !== '')
    : []

  // All "requires a value before save succeeds" checks, derived from state.
  // Flipping any failing field to valid clears its error highlight live.
  const imagesFinishKeys = optionMode ? selectedOptions : ['']
  const validations = {
    images:         imagesFinishKeys.every(fk => (imagesByOption[fk] ?? []).length > 0),
    pricingDisplay: pricingDisplay !== null,
    material:       !!selectedMaterialId,
    variant:        !variantRequired || selectedVariantIds.length > 0,
    currency:       isCustomQuote || currency !== null,
    inkNames:       !requiresInkNames || (inkCount > 0 && inkNameValidities.every(Boolean)),
  } as const
  const isValid = Object.values(validations).every(Boolean)
  const shouldHighlight = (k: keyof typeof validations) => submitAttempted && !validations[k]

  // Specific images message so the designer knows which finish tab needs attention.
  const invalidOptionKey = !validations.images
    ? imagesFinishKeys.find(fk => (imagesByOption[fk] ?? []).length === 0)
    : undefined
  const imagesHint = invalidOptionKey !== undefined && invalidOptionKey !== ''
    ? `At least one image required for ${availableOptions.find(f => f.code === invalidOptionKey)?.display_name ?? invalidOptionKey}.`
    : 'At least one proof image required.'

  // Preserve previously-entered ink data when switching between "requires
  // per-ink" and optional materials — best-effort, joined/split on commas.
  function handleMaterialChange(nextId: string) {
    const prev = materials.find(m => m.id === selectedMaterialId)
    const next = materials.find(m => m.id === nextId)
    const wasRequired = prev?.requires_ink_names ?? false
    const isRequired  = next?.requires_ink_names ?? false
    if (wasRequired && !isRequired) {
      const joined = inkNamesArray.filter(s => s.trim()).join(', ')
      if (joined) setInkNamesText(joined)
    } else if (!wasRequired && isRequired) {
      const parts = inkNamesText.split(',').map(s => s.trim()).filter(Boolean)
      if (parts.length > 0) setInkNamesArray(parts)
    }
    setSelectedMaterialId(nextId)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <PageDropOverlay visible={isPageDragOver} />
      {validationToast && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-rose-50 px-5 py-2.5 text-sm font-medium text-rose-700 shadow-lg ring-1 ring-rose-200"
        >
          {validationToast}
        </div>
      )}
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to proof</Link>
        </div>

        {/* Page heading + actions */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Add version</h1>
            {proofName && <p className="mt-1 text-gray-500">{proofName}</p>}
            {proofCompany && <p className="text-sm text-gray-400">{proofCompany}</p>}
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
              disabled={submitting || !isValid}
              title={!isValid ? missingFieldsHint(validations) : undefined}
              aria-label={
                !isValid
                  ? `Save version — ${missingFieldsHint(validations)}`
                  : undefined
              }
              className={[
                'rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
                isValid ? 'bg-gray-900 hover:bg-gray-700' : 'bg-gray-900/60',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              {submitting ? 'Uploading and saving…' : 'Save version'}
            </button>
          </div>
        </div>

        <form id="new-version-form" onSubmit={handleSubmit} className="space-y-6">

          {/* Pricing display — required choice between standard grid and custom quote */}
          <PricingDisplayField
            value={pricingDisplay}
            onChange={setPricingDisplay}
            invalid={shouldHighlight('pricingDisplay')}
            forwardRef={pricingDisplayRef}
          />
          {pricingDisplay === null && !shouldHighlight('pricingDisplay') && (
            <p className="-mt-3 text-xs text-gray-400">Select one.</p>
          )}

          {/* Material + variant + material-options selection */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material</label>
              <select
                ref={materialRef}
                value={selectedMaterialId}
                onChange={(e) => handleMaterialChange(e.target.value)}
                className={[selectClass, shouldHighlight('material') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
              >
                <option value="">Select a material…</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
              {shouldHighlight('material') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
            </div>

            {variantRequired && variants.length > 0 && variantType !== 'default' && (
              <div ref={variantRef} className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  {variantLabel(variantType)}
                  {isMultiVariant && <span className="ml-2 font-normal text-gray-400">— select all to expose on the proof</span>}
                </label>

                {isMultiVariant ? (
                  <div className={[
                    'flex flex-wrap gap-2 rounded-lg',
                    shouldHighlight('variant') ? 'p-2 ring-1 ring-rose-300' : '',
                  ].join(' ')}>
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
                    onChange={(e) => setSelectedVariantIds(e.target.value ? [e.target.value] : [])}
                    className={[selectClass, shouldHighlight('variant') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
                  >
                    <option value="">Select…</option>
                    {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                  </select>
                )}
                {shouldHighlight('variant') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
              </div>
            )}

            {/* Option selection — for materials that expose multi-options
                (finishes on metals, species on wood, etc.) */}
            {hasOptions && (
              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">{optionLabelPlural}</label>
                <div className="flex flex-wrap gap-2">
                  {availableOptions.map(o => {
                    const selected = selectedOptions.includes(o.code)
                    return (
                      <button
                        key={o.code}
                        type="button"
                        onClick={() => toggleOption(o.code)}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium ring-1 transition-colors',
                          selected
                            ? 'bg-gray-900 text-white ring-gray-900'
                            : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50',
                        ].join(' ')}
                      >
                        {o.display_name}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1.5 text-xs text-gray-400">
                  Select which {optionLabelPlural.toLowerCase()} to offer. Each {optionLabelSingular.toLowerCase()} gets its own proof images.
                </p>
              </div>
            )}

            {!isCustomQuote && (
              <div ref={currencyRef} className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
                <CurrencyField value={currency} onChange={setCurrency} invalid={shouldHighlight('currency')} />
                {shouldHighlight('currency')
                  ? <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>
                  : currency === null
                    ? <p className="mt-1.5 text-xs text-gray-400">Select one.</p>
                    : null}
              </div>
            )}

            {requiresInkNames ? (
              <div ref={inkNamesRef}>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Ink names</label>
                {inkCount === 0 ? (
                  <p className="text-sm text-gray-400">Select a variant to enter ink names.</p>
                ) : (
                  <div className="space-y-2">
                    {Array.from({ length: inkCount }).map((_, i) => {
                      const fieldInvalid = submitAttempted && !inkNameValidities[i]
                      return (
                        <div key={i}>
                          <label className="mb-0.5 block text-xs font-medium text-gray-500">Ink {i + 1}</label>
                          <input
                            type="text"
                            placeholder="e.g. Pantone 185 C"
                            value={inkNamesArray[i] ?? ''}
                            onChange={(e) => {
                              const next = [...inkNamesArray]
                              next[i] = e.target.value
                              setInkNamesArray(next)
                            }}
                            className={[
                              inputClass,
                              fieldInvalid ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : '',
                            ].join(' ')}
                          />
                          {fieldInvalid && <p className="mt-1 text-xs font-medium text-rose-500">Required</p>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
                </label>
                <input type="text" placeholder="e.g. Pantone 185 C, Metallic Gold" value={inkNamesText}
                  onChange={(e) => setInkNamesText(e.target.value)} className={inputClass} />
              </div>
            )}

          </section>

          {/* Image upload */}
          <section ref={imageSectionRef} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">
              Proof images
              {currentImages.length > 0 && (
                <span className="ml-2 font-normal normal-case text-gray-400">— drag to reorder</span>
              )}
            </h2>

            {/* Option tabs */}
            {optionMode && selectedOptions.length > 0 && (
              <div className="mb-4 flex gap-0 border-b border-gray-100">
                {selectedOptions.map(fCode => {
                  const f = availableOptions.find(x => x.code === fCode)
                  const isActive = activeImageOption === fCode
                  return (
                    <button
                      key={fCode}
                      type="button"
                      onClick={() => setActiveImageOption(fCode)}
                      className={[
                        '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'border-gray-900 text-gray-900'
                          : 'border-transparent text-gray-400 hover:text-gray-700',
                      ].join(' ')}
                    >
                      {f?.display_name ?? fCode}
                      <span className={['ml-1.5 text-xs', isActive ? 'text-gray-400' : 'text-gray-300'].join(' ')}>
                        ({(imagesByOption[fCode] ?? []).length})
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
                  accept="image/jpeg"
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
                      : shouldHighlight('images')
                        ? 'border-dashed border-rose-300 text-rose-500 hover:border-rose-400 hover:text-rose-600'
                        : 'border-dashed border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600',
                  ].join(' ')}
                >
                  {isZoneDragOver
                    ? 'Drop to add images'
                    : currentImages.length === 0
                      ? 'Click or drop to upload JPEG (max 10 MB each)'
                      : `Add more images (${currentImages.length} / ${MAX_IMAGES})`}
                </button>
              </>
            )}

            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
            {fileNote && <p className="mt-2 text-sm text-gray-500">{fileNote}</p>}
            {shouldHighlight('images') && (
              <p className="mt-2 text-xs font-medium text-rose-500">{imagesHint}</p>
            )}
          </section>

          {/* Change notes */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Change notes</h2>
            <textarea rows={3} placeholder="What changed in this version? Shown to the customer."
              value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} className={inputClass} />
          </section>

          {/* Pricing — one section per selected variant. Hidden in custom-quote
              mode and until a currency is picked. */}
          {!isCustomQuote && selectedVariantIds.length > 0 && currency !== null && selectedVariantIds.map((vid) => {
            const variant = variants.find((v) => v.id === vid)
            const tiers = variantTiers[vid] ?? []
            const snap = variantSnapshots[vid] ?? {}
            if (!variant) return null

            const material = materials.find((m) => m.id === selectedMaterialId)
            const featuredSet = new Set(material?.featured_quantities ?? DEFAULT_FEATURED_QUANTITIES)
            const isOverridden = (qty: number) => {
              const t = tiers.find((x) => x.quantity === qty)
              if (!t) return false
              const v = snap[qty]
              if (v === undefined) return false
              return parseFloat(v) !== t.total_price
            }
            const hiddenOverrides = tiers.filter((t) => !featuredSet.has(t.quantity) && isOverridden(t.quantity))
            const userExpanded = !!expandedVariants[vid]
            const visibleTiers = tiers.filter((t) => {
              if (featuredSet.has(t.quantity)) return true
              if (isOverridden(t.quantity)) return true   // keep any user edits visible
              return userExpanded
            })
            const hiddenCount = tiers.length - visibleTiers.length
            const showToggle = hiddenCount > 0 || (userExpanded && tiers.length > featuredSet.size)

            return (
              <section key={vid} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing — {variantType === 'default' ? material_display_for(selectedMaterialId, materials) : variant.display_name}
                </h2>
                <p className="mb-4 text-xs text-gray-400">
                  {tiers.length > 0 ? 'Pre-filled from live pricing. Edit any value to override.' : 'No price tiers found for this variant and currency.'}
                </p>
                {tiers.length > 0 && (
                  <>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="w-6 pb-2" />
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total ({currency})</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleTiers.map((tier) => {
                          const val = snap[tier.quantity] ?? ''
                          const parsed = parseFloat(val)
                          const overridden = isOverridden(tier.quantity)
                          return (
                            <tr key={tier.quantity} className="border-b border-gray-50 last:border-0">
                              <td className="py-2 pr-1">
                                {overridden && (
                                  <span
                                    className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
                                    title="Edited — differs from the live price"
                                    aria-label="Edited"
                                  />
                                )}
                              </td>
                              <td className="py-2 pr-4 font-medium text-gray-900">{tier.quantity.toLocaleString()}</td>
                              <td className="py-2 pr-4">
                                <input
                                  type="number" step="0.01" min="0" value={val}
                                  onChange={(e) => updatePrice(vid, tier.quantity, e.target.value)}
                                  className={[
                                    'w-28 rounded border px-2 py-1 text-sm focus:outline-none',
                                    overridden
                                      ? 'border-amber-300 focus:border-amber-500'
                                      : 'border-gray-200 focus:border-gray-900',
                                  ].join(' ')}
                                />
                              </td>
                              <td className="py-2 text-xs text-gray-500">
                                {!isNaN(parsed) && parsed > 0 ? formatPrice(parsed / tier.quantity, currency, 2) : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {showToggle && (
                      <button
                        type="button"
                        onClick={() => setExpandedVariants(prev => ({ ...prev, [vid]: !prev[vid] }))}
                        className="mt-3 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                      >
                        {userExpanded
                          ? 'Hide extra tiers'
                          : `Show all tiers${hiddenCount > 0 ? ` (${hiddenCount} more)` : ''}`}
                      </button>
                    )}
                    {!userExpanded && hiddenOverrides.length === 0 && hiddenCount === 0 && null}
                  </>
                )}
              </section>
            )
          })}

          {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        </form>
      </div>
    </div>
  )
}

/** Build a compact "Select a X and a Y" hint for the Save button's
 *  disabled tooltip from the current validation results. Pricing
 *  display + currency are the two fields the admin "no default" setting
 *  can leave unselected; other validation errors are reported inline. */
function missingFieldsHint(validations: Record<string, boolean>): string {
  const missing: string[] = []
  if (!validations.pricingDisplay) missing.push('a pricing display')
  if (!validations.currency) missing.push('a currency')
  if (!validations.material) missing.push('a material')
  if (!validations.variant) missing.push('a variant')
  if (!validations.images) missing.push('at least one image')
  if (!validations.inkNames) missing.push('ink names')
  if (missing.length === 0) return 'Some required fields are incomplete'
  if (missing.length === 1) return `Select ${missing[0]}`
  if (missing.length === 2) return `Select ${missing[0]} and ${missing[1]}`
  return `Select ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
}

function material_display_for(id: string, materials: Material[]) {
  return materials.find((m) => m.id === id)?.display_name ?? ''
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
const selectClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 bg-white'
