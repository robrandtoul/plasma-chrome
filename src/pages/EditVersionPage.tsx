import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { pluralLabel } from '../lib/labels'
import { PricingDisplay } from '../components/PricingDisplay'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import { PageDropOverlay } from '../components/PageDropOverlay'
import type { Currency, PricingSnapshot } from '../lib/types'

// ── Types ──────────────────────────────────────────────────────────────────────

type EditImage =
  | { kind: 'existing'; id: string; image_path: string; label: string; preview: string; material_option: string | null; original_filename: string | null }
  | { kind: 'new'; localId: string; file: File; preview: string; label: string }

interface MaterialOption {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png']
const MAX_IMAGES = 10

function defaultLabel(index: number): string {
  if (index === 0) return 'Front'
  if (index === 1) return 'Back'
  return `Image ${index + 1}`
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function EditVersionPage() {
  const { id: proofId, versionId } = useParams<{ id: string; versionId: string }>()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [proofName, setProofName] = useState('')
  const [proofCompany, setProofCompany] = useState('')
  const [versionNumber, setVersionNumber] = useState(0)
  const [materialDisplay, setMaterialDisplay] = useState('')
  // Two ink states: one for the comma-separated optional UI, one for the
  // per-ink mandatory UI. Only the one matching the loaded material's
  // requires_ink_names flag is populated on mount.
  const [inkNamesText, setInkNamesText] = useState('')
  const [inkNamesArray, setInkNamesArray] = useState<string[]>([])
  const [requiresInkNames, setRequiresInkNames] = useState(false)
  const [optionLabelSingular, setOptionLabelSingular] = useState('Finish')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [pricingSnapshot, setPricingSnapshot] = useState<PricingSnapshot | null>(null)
  const [shippingNote, setShippingNote] = useState('')
  const [featuredQuantities, setFeaturedQuantities] = useState<number[]>([100, 250, 500, 750, 1000])
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [editImagesByOption, setEditImagesByOption] = useState<Record<string, EditImage[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')
  const [originalImageIds, setOriginalImageIds] = useState<Set<string>>(new Set())
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [validationToast, setValidationToast] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fileRef         = useRef<HTMLInputElement>(null)
  const dragIndexRef    = useRef<number | null>(null)
  const imageSectionRef = useRef<HTMLElement | null>(null)
  const materialRef     = useRef<HTMLInputElement>(null)
  const inkNamesRef     = useRef<HTMLDivElement>(null)
  const toastTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!proofId || !versionId) return
    loadAll(proofId, versionId)
  }, [proofId, versionId])

  async function loadAll(pid: string, vid: string) {
    const [proofResult, versionResult, imagesResult] = await Promise.all([
      supabase.from('proofs').select('contacts(full_name, companies(name))').eq('id', pid).single(),
      supabase
        .from('proof_versions')
        .select('version_number, material_id, material_display, ink_names, currency, change_notes, pricing_snapshot, shipping_note, material_options, custom_quote, materials(featured_quantities, requires_ink_names, option_label)')
        .eq('id', vid)
        .single(),
      supabase
        .from('proof_version_images')
        .select('id, image_path, label, sort_order, material_option, original_filename')
        .eq('proof_version_id', vid)
        .order('sort_order'),
    ])

    if (versionResult.error || !versionResult.data) {
      navigate(`/proofs/${pid}`)
      return
    }

    const c = (proofResult.data?.contacts as any)
    if (c) {
      setProofName(c.full_name ?? '')
      setProofCompany(c.companies?.name ?? '')
    }

    const v = versionResult.data as any
    setVersionNumber(v.version_number)
    setMaterialDisplay(v.material_display)
    const rawInkNames = (v.ink_names as string[]) ?? []
    const materialMeta = (v.materials as any) ?? {}
    const materialRequiresInkNames: boolean = !!materialMeta.requires_ink_names
    setRequiresInkNames(materialRequiresInkNames)
    setOptionLabelSingular(materialMeta.option_label ?? 'Finish')
    if (materialRequiresInkNames) {
      setInkNamesArray(rawInkNames)
    } else {
      setInkNamesText(rawInkNames.join(', '))
    }
    setCurrency(v.currency as Currency)
    setChangeNotes(v.change_notes ?? '')
    setPricingDisplay(v.custom_quote ? 'custom' : 'standard')
    setPricingSnapshot(v.pricing_snapshot as PricingSnapshot)
    setShippingNote(v.shipping_note)
    setFeaturedQuantities(v.materials?.featured_quantities ?? [100, 250, 500, 750, 1000])

    const versionOptions = (v.material_options as string[]) ?? []
    const materialId = v.material_id as string

    // Load available options for this material
    const { data: optionData } = await supabase
      .from('material_options')
      .select('id, code, display_name, is_base, sort_order')
      .eq('material_id', materialId)
      .order('sort_order')
    const options = (optionData ?? []) as MaterialOption[]
    setAvailableOptions(options)
    setSelectedOptions(versionOptions)
    setActiveImageOption(versionOptions[0] ?? '')

    const rawImages = (imagesResult.data ?? []) as { id: string; image_path: string; label: string; sort_order: number; material_option: string | null; original_filename: string | null }[]
    const ids = new Set(rawImages.map((img) => img.id))
    setOriginalImageIds(ids)

    const withPreviews = await Promise.all(
      rawImages.map(async (img) => {
        const { data } = await supabase.storage
          .from('proof-images')
          .createSignedUrl(img.image_path, 3600)
        return {
          kind: 'existing' as const,
          id: img.id,
          image_path: img.image_path,
          label: img.label,
          material_option: img.material_option,
          original_filename: img.original_filename,
          preview: data?.signedUrl ?? '',
        }
      })
    )

    // Group images by option key
    const ibf: Record<string, EditImage[]> = {}
    for (const img of withPreviews) {
      let key: string
      if (versionOptions.length === 0) {
        key = ''
      } else {
        // Images with null material_option belong to the base option (migrated data)
        key = img.material_option ?? (options.find(o => o.is_base)?.code ?? versionOptions[0])
      }
      if (!ibf[key]) ibf[key] = []
      ibf[key].push(img)
    }
    // Ensure all selectedOptions have entries (some may have no images yet)
    for (const code of versionOptions) {
      if (!ibf[code]) ibf[code] = []
    }
    if (versionOptions.length === 0 && !ibf['']) ibf[''] = []
    setEditImagesByOption(ibf)

    setLoading(false)
  }

  // Derived
  const hasOptions   = availableOptions.length > 0
  const optionMode   = hasOptions && selectedOptions.length > 0
  const optionLabelPlural = pluralLabel(optionLabelSingular)
  const activeKey     = optionMode ? activeImageOption : ''
  const currentImages = editImagesByOption[activeKey] ?? []
  const isCustomQuote = pricingDisplay === 'custom'

  // Edit doesn't allow variant changes, so ink-field count defaults to what
  // was saved (min 1 so a version somehow created with no names can be fixed).
  const editInkCount = requiresInkNames ? Math.max(inkNamesArray.length, 1) : 0

  const inkNameValidities = requiresInkNames && editInkCount > 0
    ? Array.from({ length: editInkCount }, (_, i) => (inkNamesArray[i] ?? '').trim() !== '')
    : []

  const imagesFinishKeys = optionMode ? selectedOptions : ['']
  const validations = {
    images:   imagesFinishKeys.every(fk => (editImagesByOption[fk] ?? []).length > 0),
    material: materialDisplay.trim() !== '',
    inkNames: !requiresInkNames || (editInkCount > 0 && inkNameValidities.every(Boolean)),
  } as const
  const isValid = Object.values(validations).every(Boolean)
  const shouldHighlight = (k: keyof typeof validations) => submitAttempted && !validations[k]

  const invalidOptionKey = !validations.images
    ? imagesFinishKeys.find(fk => (editImagesByOption[fk] ?? []).length === 0)
    : undefined
  const imagesHint = invalidOptionKey !== undefined && invalidOptionKey !== ''
    ? `At least one image required for ${availableOptions.find(f => f.code === invalidOptionKey)?.display_name ?? invalidOptionKey}.`
    : 'At least one proof image required.'

  function toggleOption(code: string) {
    setSelectedOptions(prev => {
      if (prev.includes(code)) {
        // Deselecting — revoke new image previews and remove from map
        setEditImagesByOption(ibf => {
          const imgs = ibf[code] ?? []
          imgs.forEach(img => { if (img.kind === 'new') URL.revokeObjectURL(img.preview) })
          const { [code]: _removed, ...rest } = ibf
          return rest
        })
        const next = prev.filter(c => c !== code)
        if (activeImageOption === code) setActiveImageOption(next[0] ?? '')
        return next
      } else {
        // Selecting — if entering finish mode for first time, migrate '' images
        setEditImagesByOption(ibf => {
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

    const okByType = files.filter(f => ACCEPTED_TYPES.includes(f.type))
    const rejectedByType = files.length - okByType.length
    if (okByType.length === 0) {
      setFileError('Only image files can be added.')
      return
    }

    const okBySize = okByType.filter(f => f.size <= MAX_FILE_SIZE)
    const rejectedBySize = okByType.length - okBySize.length
    if (okBySize.length === 0) {
      setFileError('Each image must be 10 MB or smaller.')
      return
    }

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

    setEditImagesByOption(prev => {
      const cur = prev[activeKey] ?? []
      const currentCount = cur.length
      return {
        ...prev,
        [activeKey]: [
          ...cur,
          ...toAdd.map((file, i) => ({
            kind: 'new' as const,
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

  function removeImage(key: string) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).filter(img => {
        if (img.kind === 'existing') return img.id !== key
        if (img.kind === 'new') {
          if (img.localId === key) { URL.revokeObjectURL(img.preview); return false }
        }
        return true
      }),
    }))
  }

  function updateLabel(key: string, label: string) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(img => {
        if (img.kind === 'existing' && img.id === key) return { ...img, label }
        if (img.kind === 'new' && img.localId === key) return { ...img, label }
        return img
      }),
    }))
  }

  function handleDragStart(index: number) { dragIndexRef.current = index }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || from === index) return
    setEditImagesByOption(prev => {
      const cur = [...(prev[activeKey] ?? [])]
      const [item] = cur.splice(from, 1)
      cur.splice(index, 0, item)
      return { ...prev, [activeKey]: cur }
    })
    dragIndexRef.current = index
  }

  function handleDragEnd() { dragIndexRef.current = null }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSubmitAttempted(true)

    if (!isValid) {
      const order: Array<{
        key: keyof typeof validations
        ref: React.RefObject<HTMLElement | null>
      }> = [
        { key: 'material', ref: materialRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'inkNames', ref: inkNamesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'images',   ref: imageSectionRef },
      ]
      const first = order.find(o => !validations[o.key])
      first?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setValidationToast('Please complete all required fields to save')
      toastTimerRef.current = setTimeout(() => setValidationToast(''), 5000)
      return
    }

    setSubmitting(true)

    // Upload new images across all finish tabs
    const optionKeys = optionMode ? selectedOptions : ['']
    const newImages = optionKeys.flatMap(fk =>
      (editImagesByOption[fk] ?? [])
        .filter((img): img is Extract<EditImage, { kind: 'new' }> => img.kind === 'new')
        .map(img => ({ img, fk }))
    )

    const uploadResults = await Promise.all(
      newImages.map(async ({ img }) => {
        const ext = img.file.type === 'image/png' ? 'png' : 'jpg'
        const path = `${proofId}/${uuidv4()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('proof-images')
          .upload(path, img.file, { contentType: img.file.type, upsert: false })
        return { localId: img.localId, path, error: uploadError }
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

    const uploadedPathByLocalId = Object.fromEntries(uploadResults.map((r) => [r.localId, r.path]))

    // Determine which original images were removed
    const remainingExistingIds = new Set(
      Object.values(editImagesByOption).flat()
        .filter((img): img is Extract<EditImage, { kind: 'existing' }> => img.kind === 'existing')
        .map(img => img.id)
    )
    const removedIds = [...originalImageIds].filter(id => !remainingExistingIds.has(id))

    let removedPaths: string[] = []
    if (removedIds.length > 0) {
      const { data: removedRows } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('id', removedIds)
      removedPaths = (removedRows ?? []).map((r: any) => r.image_path)
    }

    // Update proof_version (including material_options)
    const { error: updateErr } = await supabase
      .from('proof_versions')
      .update({
        material_display: materialDisplay.trim(),
        ink_names: requiresInkNames
          ? inkNamesArray.map(s => s.trim())
          : inkNamesText.split(',').map(s => s.trim()).filter(Boolean),
        change_notes: changeNotes.trim() || null,
        material_options: selectedOptions,
        custom_quote: pricingDisplay === 'custom',
      })
      .eq('id', versionId!)

    if (updateErr) {
      setError(`Failed to save: ${updateErr.message}`)
      setSubmitting(false)
      return
    }

    // Delete removed images
    if (removedIds.length > 0) {
      await supabase.from('proof_version_images').delete().in('id', removedIds)
      if (removedPaths.length > 0) {
        await supabase.storage.from('proof-images').remove(removedPaths)
      }
    }

    // Update sort_order, label, and material_option on remaining existing images
    await Promise.all(
      optionKeys.flatMap(fk => {
        const optionValue = fk === '' ? null : fk
        return (editImagesByOption[fk] ?? [])
          .map((img, idx) => {
            if (img.kind !== 'existing') return null
            return supabase
              .from('proof_version_images')
              .update({ label: img.label, sort_order: idx, material_option: optionValue })
              .eq('id', img.id)
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
      })
    )

    // Insert new images
    const newImageInserts = optionKeys.flatMap(fk => {
      const optionValue = fk === '' ? null : fk
      return (editImagesByOption[fk] ?? [])
        .map((img, idx) => {
          if (img.kind !== 'new') return null
          const path = uploadedPathByLocalId[(img as Extract<EditImage, { kind: 'new' }>).localId]
          if (!path) return null
          return {
            proof_version_id: versionId!,
            image_path: path,
            label: img.label,
            sort_order: idx,
            material_option: optionValue,
            original_filename: img.file.name,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    })

    if (newImageInserts.length > 0) {
      const { error: insertErr } = await supabase.from('proof_version_images').insert(newImageInserts)
      if (insertErr) {
        setError(`Failed to save new images: ${insertErr.message}`)
        setSubmitting(false)
        return
      }
    }

    navigate(`/proofs/${proofId}`)
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
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
            <h1 className="text-2xl font-bold text-gray-900">Edit v{versionNumber}</h1>
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
              form="edit-version-form"
              disabled={submitting}
              aria-label={
                submitAttempted && !isValid
                  ? 'Save version — some required fields are incomplete'
                  : undefined
              }
              className={[
                'rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
                isValid ? 'bg-gray-900 hover:bg-gray-700' : 'bg-gray-900/60 hover:bg-gray-900/75',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              {submitting ? 'Saving…' : 'Save version'}
            </button>
          </div>
        </div>

        <form id="edit-version-form" onSubmit={handleSubmit} className="space-y-6">

          {/* Pricing display — required choice between standard grid and custom quote */}
          <PricingDisplayField value={pricingDisplay} onChange={setPricingDisplay} />

          {/* Specification */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material display name</label>
              <input
                ref={materialRef}
                type="text"
                value={materialDisplay}
                onChange={(e) => setMaterialDisplay(e.target.value)}
                className={[inputClass, shouldHighlight('material') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
              />
              {shouldHighlight('material') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
            </div>

            {/* Option selection — for materials that expose multi-options */}
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

            {requiresInkNames ? (
              <div ref={inkNamesRef} className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Ink names</label>
                <div className="space-y-2">
                  {Array.from({ length: editInkCount }).map((_, i) => {
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
              </div>
            ) : (
              <div className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
                </label>
                <input
                  type="text"
                  value={inkNamesText}
                  onChange={(e) => setInkNamesText(e.target.value)}
                  placeholder="e.g. Pantone 185 C, Metallic Gold"
                  className={inputClass}
                />
              </div>
            )}

            {!isCustomQuote && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
                <div>
                  <CurrencyField value={currency} onChange={() => {}} disabled />
                  <p className="mt-1.5 text-xs text-gray-400">Cannot be changed after creation.</p>
                </div>
              </div>
            )}

          </section>

          {/* Images */}
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
                        ({(editImagesByOption[fCode] ?? []).length})
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {currentImages.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {currentImages.map((entry, index) => {
                  const key = entry.kind === 'existing' ? entry.id : entry.localId
                  const filename = entry.kind === 'existing' ? entry.original_filename : entry.file.name
                  return (
                    <div
                      key={key}
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
                        onChange={(e) => updateLabel(key, e.target.value)}
                        className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                        placeholder="Label"
                      />
                      {filename && (
                        <p className="mt-1 truncate text-[11px] text-gray-400" title={filename}>
                          {filename}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => removeImage(key)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
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
                      : shouldHighlight('images')
                        ? 'border-dashed border-rose-300 text-rose-500 hover:border-rose-400 hover:text-rose-600'
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
            {shouldHighlight('images') && (
              <p className="mt-2 text-xs font-medium text-rose-500">{imagesHint}</p>
            )}
          </section>

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

          {/* Pricing — read-only. Hidden when this version is a custom quote. */}
          {!isCustomQuote && pricingSnapshot && (
            <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Pricing</h2>
                <span className="text-xs text-gray-400">Read-only — locked at creation</span>
              </div>
              <PricingDisplay
                snapshot={pricingSnapshot}
                currency={currency}
                featuredQuantities={featuredQuantities}
              />
              <div className="border-t border-gray-100 px-6 py-3">
                <p className="text-xs text-gray-400">
                  {currency === 'GBP' ? 'Prices include VAT. ' : ''}
                  {shippingNote}
                </p>
              </div>
            </section>
          )}

          {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        </form>
      </div>
    </div>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
