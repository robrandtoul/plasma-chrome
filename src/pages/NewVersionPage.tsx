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
import NameChipInput from '../components/NameChipInput'
import { matchImageToName } from '../lib/matchImageToName'
import type { Currency } from '../lib/types'

interface Material {
  id: string
  display_name: string
  requires_ink_names: boolean
  option_label: string | null
  featured_quantities: number[] | null
  multi_variant: boolean
  // Needed so the inheritance path can tag a material as "archived
  // since the prior version was made" and surface a warning near
  // the picker. Filtered out of the default list, but present when
  // the inherited material has been archived since v1.
  archived_at: string | null
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
  // Pre-populated from matchImageToName when the file is added.
  // Designer can override via the per-image dropdowns before save.
  associated_name: string | null
  side: 'front' | 'back' | null
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

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
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({})
  // Inheritance markers. Populated on mount when creating v2+ — the
  // form reads the proof's current version and pre-fills currency /
  // material / variants. Each boolean drives a muted "Inherited from
  // vN" label next to its field; the flag clears when the designer
  // edits the field, at which point the label disappears.
  //
  // inheritedVariantIdsRef stashes the variant IDs to restore after
  // the material's variants load — can't be state because the
  // variants-loading effect needs to read it synchronously and it
  // shouldn't trigger a re-render when consumed. Cleared once the
  // effect applies it.
  //
  // inheritedMaterialArchived surfaces a warning near the material
  // field when the inherited material has been archived since the
  // prior version was made. Designer can keep it or pick fresh.
  const [inheritedVersionNumber, setInheritedVersionNumber] = useState<number | null>(null)
  const [inheritedCurrency, setInheritedCurrency] = useState(false)
  const [inheritedMaterial, setInheritedMaterial] = useState(false)
  const [inheritedVariants, setInheritedVariants] = useState(false)
  const [inheritedMaterialArchived, setInheritedMaterialArchived] = useState(false)
  const inheritedVariantIdsRef = useRef<string[] | null>(null)
  // Two separate ink states so each form path (free-text vs per-ink) keeps
  // typing feel. They only cross over when the designer switches materials
  // between the "requires per-ink names" set and everything else.
  const [inkNamesText, setInkNamesText] = useState('')
  const [inkNamesArray, setInkNamesArray] = useState<string[]>([])
  // Split-name tooling recipients. Pre-filled from the project's
  // most-recent prior version (if any) on mount — designer still
  // edits freely. Empty list is valid and allowed at submit.
  const [names, setNames] = useState<string[]>([])
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

    let cancelled = false

    async function load() {
      // Customer name + company for the page chrome. Fires in
      // parallel; not ordering-sensitive.
      void supabase.from('proofs').select('contacts(full_name, companies(name))').eq('id', proofId!).single()
        .then(({ data }) => {
          if (cancelled) return
          const c = (data?.contacts as any)
          if (c) {
            setProofName(c.full_name ?? '')
            setProofCompany(c.companies?.name ?? '')
          }
        })

      // Names chip-list inheritance (existing behaviour: latest
      // prior version by created_at, not is_current). Preserved as-is
      // for now; migrating to is_current is a separate call.
      void supabase.from('proof_versions')
        .select('names')
        .eq('proof_id', proofId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => {
          if (cancelled) return
          const prev = (data as any)?.names
          if (Array.isArray(prev) && prev.length > 0) setNames(prev as string[])
        })

      // Materials for the picker. Filtered to active + published +
      // non-archived by default. Inheritance below prepends an
      // archived material back in if the prior version used one,
      // so the designer can continue with it.
      const materialsPromise = supabase
        .from('materials')
        .select('id, display_name, requires_ink_names, option_label, featured_quantities, multi_variant, archived_at')
        .eq('is_active', true)
        .eq('is_published', true)
        .is('archived_at', null)
        .order('sort_order')

      // Inheritance from the proof's current version. Runs before
      // the settings-defaults fetch so currency inheritance wins
      // over the admin-configured default (specific intent beats
      // global default). is_current = true targets the designer's
      // promoted working version rather than "latest created", so
      // if those have diverged (via Set as current in the modal),
      // the promoted one is the source of truth.
      const inheritPromise = supabase
        .from('proof_versions')
        .select('version_number, currency, material_id, pricing_snapshot')
        .eq('proof_id', proofId!)
        .eq('is_current', true)
        .maybeSingle()

      const [materialsResult, inheritResult] = await Promise.all([materialsPromise, inheritPromise])
      if (cancelled) return

      let materialsList = (materialsResult.data ?? []) as Material[]
      let currencyInherited = false
      const inherited = inheritResult.data as {
        version_number: number
        currency: string
        material_id: string
        pricing_snapshot: { variants?: { variant_id?: string }[] } | null
      } | null

      if (inherited) {
        setInheritedVersionNumber(inherited.version_number)

        // Currency — always inheritable.
        setCurrency(inherited.currency as Currency)
        setInheritedCurrency(true)
        currencyInherited = true

        // Material — if the inherited material is archived, it
        // won't appear in the filtered list above. Fetch it
        // unfiltered and prepend so the picker can still show it
        // as the selected value.
        const inMain = materialsList.some((m) => m.id === inherited.material_id)
        if (!inMain) {
          const { data: archivedMatData } = await supabase
            .from('materials')
            .select('id, display_name, requires_ink_names, option_label, featured_quantities, multi_variant, archived_at')
            .eq('id', inherited.material_id)
            .maybeSingle()
          if (!cancelled && archivedMatData) {
            materialsList = [archivedMatData as Material, ...materialsList]
            setInheritedMaterialArchived(true)
          }
        }
        setMaterials(materialsList)
        setSelectedMaterialId(inherited.material_id)
        setInheritedMaterial(true)

        // Variants — stash in a ref for the variants-loading
        // effect to consume once the material's variants finish
        // loading. Without this, the material-effect's auto-select
        // would stomp the inherited IDs before they could be
        // applied.
        const variantIds = Array.isArray(inherited.pricing_snapshot?.variants)
          ? inherited.pricing_snapshot!.variants!
              .map((v) => v.variant_id)
              .filter((id): id is string => typeof id === 'string')
          : []
        if (variantIds.length > 0) {
          inheritedVariantIdsRef.current = variantIds
          setInheritedVariants(true)
        }
      } else {
        // v1 — no inheritance, just hydrate the picker with the
        // unfiltered active+published materials.
        setMaterials(materialsList)
      }

      // Settings defaults — currency default only applies if we
      // didn't inherit one. Pricing display default is independent
      // (not inherited — it's a per-version choice).
      const { data: settings } = await supabase
        .from('settings')
        .select('default_pricing_display, default_currency')
        .eq('id', 1)
        .single()
      if (cancelled) return
      if (settings) {
        if (settings.default_pricing_display != null) {
          setPricingDisplay((settings.default_pricing_display === 'custom_quote' ? 'custom' : 'standard') as PricingDisplayValue)
        }
        if (!currencyInherited && settings.default_currency != null) {
          setCurrency(settings.default_currency as Currency)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [proofId])

  useEffect(() => {
    setVariants([])
    setSelectedVariantIds([])
    setVariantTiers({})
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

      // Inheritance path. If the mount effect stashed variant IDs
      // to restore, use them now — intersected with the variants
      // that actually loaded (defensive in case a variant has been
      // retired between versions). Consume the ref either way so a
      // subsequent material change doesn't accidentally re-apply.
      if (inheritedVariantIdsRef.current) {
        const validInherited = inheritedVariantIdsRef.current.filter((id) =>
          v.some((x) => x.id === id),
        )
        inheritedVariantIdsRef.current = null
        if (validInherited.length > 0) {
          setSelectedVariantIds(validInherited)
          return
        }
        // Fell through — inherited IDs no longer match any variant
        // (rare: variant retired). Clear the inheritance label and
        // let the auto-select logic below pick defaults.
        setInheritedVariants(false)
      }

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
        rows.forEach((r) => {
          if (!tiersMap[r.material_variant_id]) tiersMap[r.material_variant_id] = []
          tiersMap[r.material_variant_id].push(r)
        })
        setVariantTiers(tiersMap)
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
      return {
        ...prev,
        [activeKey]: [
          ...cur,
          ...toAdd.map((file) => {
            const match = matchImageToName(file.name, names)
            return {
              localId: uuidv4(),
              file,
              preview: URL.createObjectURL(file),
              associated_name: match.associatedName,
              side: match.side,
            }
          }),
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

  function updateAssociatedName(localId: string, associated_name: string | null) {
    setImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(e => e.localId === localId ? { ...e, associated_name } : e),
    }))
  }

  function updateSide(localId: string, side: 'front' | 'back' | null) {
    setImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(e => e.localId === localId ? { ...e, side } : e),
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

  // Chip removal reconciliation: when the designer drops a chip
  // from the names list, any images currently associated with that
  // name fall back to the "null = shared" convention. The update
  // is purely in-state — the version hasn't been persisted yet, so
  // the cleared association lands in the DB at Save time via the
  // existing insert payload.
  function handleNamesChange(next: string[]) {
    const removed = names.filter((n) => !next.includes(n))
    if (removed.length > 0) {
      setImagesByOption((prev) => {
        const out: Record<string, typeof prev[string]> = {}
        for (const [key, list] of Object.entries(prev)) {
          out[key] = list.map((img) =>
            img.associated_name != null && removed.includes(img.associated_name)
              ? { ...img, associated_name: null }
              : img,
          )
        }
        return out
      })
    }
    setNames(next)
  }

  function toggleVariant(variantId: string) {
    setSelectedVariantIds((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    )
    // Manual variant change clears the inheritance label — the set
    // no longer matches what was carried forward.
    setInheritedVariants(false)
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

    // Freeze the live prices into the version's pricing_snapshot so
    // the version has a stable record independent of any future
    // changes made in Admin → Pricing. Read straight from
    // variantTiers now that the form is read-only — the intermediate
    // variantSnapshots state that used to track user edits is gone.
    const pricingSnapshot = {
      variants: selectedVariantIds.map((vid) => {
        const variant = variants.find((v) => v.id === vid)!
        const display = variant.variant_type === 'default' ? 'Default' : variant.display_name
        const prices: Record<string, number> = {}
        ;(variantTiers[vid] ?? []).forEach((t) => {
          prices[t.quantity] = t.total_price
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
        // Names array for split-name tooling. Empty is valid. The
        // DB trigger (migration 000070) snapshots the per-currency
        // surcharge from the material on INSERT, so no client-side
        // amount calc.
        names: names.map((n) => n.trim()).filter(Boolean),
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
        sort_order: sortOrder,
        material_option: option,
        original_filename: entry.file.name,
        associated_name: entry.associated_name,
        side: entry.side,
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
      targetLabel: `${proofName || 'project'} — ${material.display_name}`,
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
    // Manual material change clears both the material and variant
    // inheritance labels (a different material will auto-select
    // its own variants, unrelated to the carried-forward ones).
    // Also clears the archived-material warning — if the designer
    // deliberately swapped away, they're not keeping the archived
    // one. Discard any pending variant inheritance from the ref so
    // a subsequent swap back can't accidentally re-apply it.
    setInheritedMaterial(false)
    setInheritedVariants(false)
    setInheritedMaterialArchived(false)
    inheritedVariantIdsRef.current = null
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
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to project</Link>
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
              {inheritedMaterial && inheritedVersionNumber != null && !inheritedMaterialArchived && (
                <p className="mt-1.5 text-xs text-gray-400">Inherited from v{inheritedVersionNumber}</p>
              )}
              {inheritedMaterialArchived && inheritedVersionNumber != null && (
                <p className="mt-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                  The material used in v{inheritedVersionNumber} has been archived. Pick a current material or keep this one.
                </p>
              )}
            </div>

            {variantRequired && variants.length > 0 && variantType !== 'default' && (
              <div ref={variantRef} className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  {variantLabel(variantType)}
                  {isMultiVariant && <span className="ml-2 font-normal text-gray-400">— select all to expose on the proof version</span>}
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
                    onChange={(e) => {
                      setSelectedVariantIds(e.target.value ? [e.target.value] : [])
                      setInheritedVariants(false)
                    }}
                    className={[selectClass, shouldHighlight('variant') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
                  >
                    <option value="">Select…</option>
                    {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                  </select>
                )}
                {shouldHighlight('variant') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
                {inheritedVariants && inheritedVersionNumber != null && (
                  <p className="mt-1.5 text-xs text-gray-400">Inherited from v{inheritedVersionNumber}</p>
                )}
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
                <CurrencyField
                  value={currency}
                  onChange={(c) => { setCurrency(c); setInheritedCurrency(false) }}
                  invalid={shouldHighlight('currency')}
                />
                {shouldHighlight('currency')
                  ? <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>
                  : currency === null
                    ? <p className="mt-1.5 text-xs text-gray-400">Select one.</p>
                    : inheritedCurrency && inheritedVersionNumber != null
                      ? <p className="mt-1.5 text-xs text-gray-400">Inherited from v{inheritedVersionNumber}</p>
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

            {/* Names on this order — chip input backs the
                proof_versions.names array. Optional. The DB trigger
                snapshots the per-currency split-name tooling
                surcharge onto the version on save. */}
            <div className="mt-5">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Names on this order <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <NameChipInput
                names={names}
                onChange={handleNamesChange}
                placeholder="Who is this proof for? Press Enter after each name"
                ariaLabel="Names on this order"
              />
            </div>

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
                      alt={entry.file.name}
                      className="mb-2 aspect-square w-full rounded-lg object-contain"
                    />
                    {/* Per-image recipient + side. Pre-populated from
                        the filename via matchImageToName when the
                        file was added; designer can override. Shared
                        (null) + chip values fill the Name dropdown.
                        Side dropdown covers Front / Back / none. */}
                    <select
                      value={entry.associated_name ?? ''}
                      onChange={(e) => updateAssociatedName(entry.localId, e.target.value || null)}
                      className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                      aria-label="Associated name"
                    >
                      <option value="">Shared</option>
                      {names.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <select
                      value={entry.side ?? ''}
                      onChange={(e) => updateSide(entry.localId, (e.target.value || null) as 'front' | 'back' | null)}
                      className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                      aria-label="Side"
                    >
                      <option value="">—</option>
                      <option value="front">Front</option>
                      <option value="back">Back</option>
                    </select>
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

          {/* Pricing — one section per selected variant. Read-only
              reference display of live prices pulled from price_tiers
              for the chosen variant and currency. All edits happen
              in Admin → Pricing; designers see the live values here
              to confirm the customer-facing number, not to modify
              it. Hidden in custom-quote mode and until a currency is
              picked. */}
          {!isCustomQuote && selectedVariantIds.length > 0 && currency !== null && selectedVariantIds.map((vid) => {
            const variant = variants.find((v) => v.id === vid)
            const tiers = variantTiers[vid] ?? []
            if (!variant) return null

            const material = materials.find((m) => m.id === selectedMaterialId)
            const featuredSet = new Set(material?.featured_quantities ?? DEFAULT_FEATURED_QUANTITIES)
            const userExpanded = !!expandedVariants[vid]
            const visibleTiers = tiers.filter((t) => featuredSet.has(t.quantity) || userExpanded)
            const hiddenCount = tiers.length - visibleTiers.length
            const showToggle = hiddenCount > 0 || (userExpanded && tiers.length > featuredSet.size)
            const variantLabel = variantType === 'default'
              ? material_display_for(selectedMaterialId, materials)
              : variant.display_name

            return (
              <section key={vid} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing — {variantLabel}
                </h2>
                <p className="mb-4 text-xs text-gray-400">
                  {tiers.length > 0
                    ? `Reference pricing for ${variantLabel} (${currency}).`
                    : 'No price tiers found for this variant and currency.'}
                </p>
                {tiers.length > 0 && (
                  <>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total ({currency})</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleTiers.map((tier) => (
                          <tr key={tier.quantity} className="border-b border-gray-50 last:border-0">
                            <td className="py-2 pr-4 font-medium text-gray-900">{tier.quantity.toLocaleString()}</td>
                            <td className="py-2 pr-4 text-gray-900">
                              {formatPrice(tier.total_price, currency, 2)}
                            </td>
                            <td className="py-2 text-xs text-gray-500">
                              {tier.total_price > 0 ? formatPrice(tier.total_price / tier.quantity, currency, 2) : '—'}
                            </td>
                          </tr>
                        ))}
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
