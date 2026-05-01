import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { pluralLabel } from '../lib/labels'
import { DEFAULT_DISPLAY_QUANTITIES } from '../lib/constants'
import { PricingDisplay } from '../components/PricingDisplay'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import { QuoteLink } from '../components/QuoteLink'
import { PageDropOverlay } from '../components/PageDropOverlay'
import NameChipInput from '../components/NameChipInput'
import { matchImageToName } from '../lib/matchImageToName'
import { safeRemoveImagePaths } from '../lib/imageStorage'
import type { Currency, PricingSnapshot } from '../lib/types'

// ── Types ──────────────────────────────────────────────────────────────────────

type EditImage =
  | { kind: 'existing'; id: string; image_path: string; preview: string; material_option: string | null; original_filename: string | null; associated_name: string | null; side: 'front' | 'back' | null }
  | { kind: 'new';      localId: string; file: File; preview: string; associated_name: string | null; side: 'front' | 'back' | null }

// Stable identifier for an EditImage regardless of variant. Used
// by the soft-remove + Undo path (lastRemovedRef equality check)
// and by removeImage's find loop. Keeps the discriminated-union
// branching out of those call sites.
const entryId = (e: EditImage): string =>
  e.kind === 'existing' ? e.id : e.localId

// Toast variant carrying optional Undo affordance. Used by both
// the existing validation-fail flow (rose pill, no action) and
// the soft-delete-with-Undo flow on Remove (slate pill with
// inline Undo button). Both auto-dismiss at 5s; the undo path's
// timer also commits the removal (revokes blob URL on kind:'new'
// entries; existing entries have signed URLs, no revoke needed).
type Toast =
  | { kind: 'validation'; text: string }
  | { kind: 'undo'; text: string; onUndo: () => void }

interface MaterialOption {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

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
  const [names, setNames] = useState<string[]>([])
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [pricingSnapshot, setPricingSnapshot] = useState<PricingSnapshot | null>(null)
  const [shippingNote, setShippingNote] = useState('')
  const [displayQuantities, setDisplayQuantities] = useState<number[]>(DEFAULT_DISPLAY_QUANTITIES)
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [editImagesByOption, setEditImagesByOption] = useState<Record<string, EditImage[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')
  const [originalImageIds, setOriginalImageIds] = useState<Set<string>>(new Set())
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fileRef         = useRef<HTMLInputElement>(null)
  const dragIndexRef    = useRef<number | null>(null)
  const imageSectionRef = useRef<HTMLElement | null>(null)
  const materialRef     = useRef<HTMLInputElement>(null)
  const inkNamesRef     = useRef<HTMLDivElement>(null)
  const toastTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stash for undo-after-Remove. See NewVersionPage for the full
  // mechanic explainer; same shape adjusted for EditImage's
  // discriminated union. URL revocation only fires for kind:'new'
  // entries on commit; existing images carry signed URLs.
  const lastRemovedRef  = useRef<{
    entry: EditImage
    optionKey: string
    index: number
    timerId: ReturnType<typeof setTimeout>
  } | null>(null)

  useEffect(() => {
    if (!proofId || !versionId) return
    loadAll(proofId, versionId)
  }, [proofId, versionId])

  // Commit any pending soft-delete on unmount so the blob URL
  // doesn't leak across page navigations. See removeImage for
  // the soft-delete + 5s commit mechanic.
  useEffect(() => {
    return () => {
      commitPendingRemoval()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAll(pid: string, vid: string) {
    const [proofResult, versionResult, imagesResult] = await Promise.all([
      supabase.from('proofs').select('contacts(full_name, companies(name))').eq('id', pid).single(),
      supabase
        .from('proof_versions')
        .select('version_number, material_id, material_display, ink_names, currency, change_notes, pricing_snapshot, shipping_note, material_options, custom_quote, names, materials(display_quantities, requires_ink_names, option_label, multi_variant)')
        .eq('id', vid)
        .single(),
      supabase
        .from('proof_version_images')
        .select('id, image_path, sort_order, material_option, original_filename, associated_name, side')
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
    setNames(Array.isArray(v.names) ? (v.names as string[]) : [])
    setChangeNotes(v.change_notes ?? '')
    setPricingDisplay(v.custom_quote ? 'custom' : 'standard')
    setPricingSnapshot(v.pricing_snapshot as PricingSnapshot)
    setShippingNote(v.shipping_note)
    setDisplayQuantities(v.materials?.display_quantities ?? DEFAULT_DISPLAY_QUANTITIES)

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

    const rawImages = (imagesResult.data ?? []) as { id: string; image_path: string; sort_order: number; material_option: string | null; original_filename: string | null; associated_name: string | null; side: 'front' | 'back' | null }[]
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
          material_option: img.material_option,
          original_filename: img.original_filename,
          associated_name: img.associated_name,
          side: img.side,
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

  // The saved snapshot carries no per-tier prices when every variant's
  // prices map is empty (the shape a 5+ ink version has, and what any
  // historical custom-quote version produces). In that case the
  // designer MUST NOT be allowed to flip the Pricing display radio
  // from Custom back to Standard — saving would produce a version
  // marked as standard-priced with an empty grid on the customer
  // page. Since EditVersionPage doesn't allow variant changes, the
  // radio toggle is the only path to that bad state, so gating the
  // radio at the source is sufficient without a save-time guard.
  //
  // Defensive default: treat a missing / malformed pricing_snapshot
  // as "no prices available" and disable.
  const snapshotHasNoPrices = (() => {
    if (!pricingSnapshot || !Array.isArray(pricingSnapshot.variants) || pricingSnapshot.variants.length === 0) {
      return true
    }
    return pricingSnapshot.variants.every((v) => {
      const prices = v?.prices ?? {}
      return Object.keys(prices).length === 0
    })
  })()

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
      return {
        ...prev,
        [activeKey]: [
          ...cur,
          ...toAdd.map((file) => {
            const match = matchImageToName(file.name, names)
            return {
              kind: 'new' as const,
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

  // Soft remove with a 5s undo window (test-report finding (h)).
  // Mirrors NewVersionPage.removeImage; see that explainer for
  // the full mechanic. Differences here:
  //   - EditImage is a discriminated union (existing | new); the
  //     entryId helper lifts the variant branching out of every
  //     id-equality call site.
  //   - URL revocation only applies to kind:'new' entries; existing
  //     images carry signed URLs from Supabase storage and don't
  //     need a revoke.
  //   - DB deletion for kind:'existing' is still deferred to Save
  //     time via the existing diff-against-original logic. Soft
  //     removal here is purely a local-state operation; if the user
  //     undoes within 5s the entry is back in state and the diff
  //     correctly issues no DB delete.
  function removeImage(key: string) {
    const list = editImagesByOption[activeKey] ?? []
    let foundEntry: EditImage | null = null
    let foundIndex = -1
    for (let i = 0; i < list.length; i++) {
      if (entryId(list[i]) === key) {
        foundEntry = list[i]
        foundIndex = i
        break
      }
    }
    if (!foundEntry) return

    commitPendingRemoval()

    setEditImagesByOption((prev) => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).filter((img) => entryId(img) !== key),
    }))

    const entry = foundEntry
    const targetId = entryId(entry)
    const timerId = setTimeout(() => {
      if (entry.kind === 'new') URL.revokeObjectURL(entry.preview)
      const stash = lastRemovedRef.current
      if (stash && entryId(stash.entry) === targetId) {
        lastRemovedRef.current = null
      }
      setToast((curr) => (curr?.kind === 'undo' ? null : curr))
    }, 5000)

    lastRemovedRef.current = { entry, optionKey: activeKey, index: foundIndex, timerId }
    setToast({ kind: 'undo', text: 'Image removed', onUndo: undoRemove })
  }

  function undoRemove() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    setEditImagesByOption((prev) => {
      const list = [...(prev[stash.optionKey] ?? [])]
      list.splice(stash.index, 0, stash.entry)
      return { ...prev, [stash.optionKey]: list }
    })
    lastRemovedRef.current = null
    setToast(null)
  }

  function commitPendingRemoval() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    if (stash.entry.kind === 'new') URL.revokeObjectURL(stash.entry.preview)
    lastRemovedRef.current = null
  }

  function updateAssociatedName(key: string, associated_name: string | null) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(img => {
        if (img.kind === 'existing' && img.id === key) return { ...img, associated_name }
        if (img.kind === 'new' && img.localId === key) return { ...img, associated_name }
        return img
      }),
    }))
  }

  function updateSide(key: string, side: 'front' | 'back' | null) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(img => {
        if (img.kind === 'existing' && img.id === key) return { ...img, side }
        if (img.kind === 'new' && img.localId === key) return { ...img, side }
        return img
      }),
    }))
  }

  // Chip removal reconciliation. Any image whose associated_name
  // matches a removed chip has its association cleared to null
  // (= shared) so the customer page's grouped rendering doesn't
  // hold a heading for a name that no longer exists. Pure state
  // change; the DB update rides along with the normal Save path
  // which already writes associated_name on both existing-update
  // and new-insert branches.
  function handleNamesChange(next: string[]) {
    const removed = names.filter((n) => !next.includes(n))
    if (removed.length > 0) {
      setEditImagesByOption((prev) => {
        const out: Record<string, EditImage[]> = {}
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
      setToast({ kind: 'validation', text: 'Please complete all required fields to save' })
      toastTimerRef.current = setTimeout(
        () => setToast((curr) => (curr?.kind === 'validation' ? null : curr)),
        5000,
      )
      return
    }

    // Finalise any pending soft-delete before the network save.
    // Placed after the validation gate so a validation-fail path
    // doesn't pre-empt the 5s undo window. URL revocation only
    // applies to kind:'new' entries; existing entries leave no
    // hygiene work for this hook.
    commitPendingRemoval()

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
        const path = `${proofId}/${uuidv4()}.jpg`
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
        // The DB trigger recomputes split_name_surcharge_snapshot
        // from the version's material + currency, so swapping
        // material or currency here keeps the snapshot in sync.
        names: names.map((n) => n.trim()).filter(Boolean),
      })
      .eq('id', versionId!)

    if (updateErr) {
      setError(`Failed to save: ${updateErr.message}`)
      setSubmitting(false)
      return
    }

    // Delete removed images. Storage object is only actually
    // removed if no other proof_version_images row references the
    // same path — carry-forward from NewVersionPage can leave v1
    // and v2 sharing image_paths, and a blind storage.remove here
    // would nuke the counterpart version's still-referenced file.
    if (removedIds.length > 0) {
      await supabase.from('proof_version_images').delete().in('id', removedIds)
      if (removedPaths.length > 0) {
        await safeRemoveImagePaths(removedPaths)
      }
    }

    // Update sort_order, material_option, associated_name, side on remaining existing images
    await Promise.all(
      optionKeys.flatMap(fk => {
        const optionValue = fk === '' ? null : fk
        return (editImagesByOption[fk] ?? [])
          .map((img, idx) => {
            if (img.kind !== 'existing') return null
            return supabase
              .from('proof_version_images')
              .update({
                sort_order: idx,
                material_option: optionValue,
                associated_name: img.associated_name,
                side: img.side,
              })
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
            sort_order: idx,
            material_option: optionValue,
            original_filename: img.file.name,
            associated_name: img.associated_name,
            side: img.side,
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

  // Cancel + Save pair, defined once and rendered twice (top of
  // the page beside the heading, and again at the bottom of the
  // form below the image-editing section). Both renders emit
  // identical JSX, so disabled state, aria-label swaps, and any
  // future chrome stay in lockstep. The submit button carries
  // form="edit-version-form" so placement outside the <form>
  // element (top row) is as functional as placement inside
  // (bottom row). Mirrors the 66a721a pattern on
  // NewVersionPage — same rationale: the form ends in a dense
  // image-editing grid and the designer shouldn't have to
  // scroll back up to commit.
  const actionRow = (
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
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <PageDropOverlay visible={isPageDragOver} />
      {toast?.kind === 'validation' && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-rose-50 px-5 py-2.5 text-sm font-medium text-rose-700 shadow-lg ring-1 ring-rose-200"
        >
          {toast.text}
        </div>
      )}
      {toast?.kind === 'undo' && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-slate-700 px-5 py-2.5 text-sm font-medium text-white shadow-lg"
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => toast.onUndo()}
            className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider hover:bg-white/25"
          >
            Undo
          </button>
        </div>
      )}
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        {/* Back + Quote compiler. QuoteLink lives in the per-page
            header on six pages today. Future "extract shared header"
            pass should inline this once and remove the per-page
            insertions. */}
        <div className="mb-6 flex items-center justify-between">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to project</Link>
          <QuoteLink variant="inline" />
        </div>

        {/* Page heading + top actions. Cancel + Save pair is
            defined as `actionRow` above the render and emitted
            twice — here next to the heading, and again below
            the image-editing section at the bottom of the form. */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Edit v{versionNumber}</h1>
            {proofName && <p className="mt-1 text-gray-500">{proofName}</p>}
            {proofCompany && <p className="text-sm text-gray-400">{proofCompany}</p>}
          </div>
          {actionRow}
        </div>

        <form id="edit-version-form" onSubmit={handleSubmit} className="space-y-6">

          {/* Pricing display — required choice between standard grid and custom quote.
              Standard is disabled when the saved snapshot carries no
              per-tier prices (5+ ink versions, historical custom
              quotes) so the designer can't flip the version into a
              standard-priced state that has no grid to show.
              The PricingDisplayField rewrite (form polish v2) made
              the component card-less so it can sit inside parent
              cards on the new-version flow's Commercial section.
              On this edit-version surface we wrap it with the
              standalone-card chrome it used to provide internally. */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Pricing display</h2>
            <PricingDisplayField
              value={pricingDisplay}
              onChange={setPricingDisplay}
              standardDisabled={snapshotHasNoPrices}
              disabledReason="No standard pricing available for this version. Saved as a custom quote."
            />
          </section>

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

            {/* Names on this order — chip input backs
                proof_versions.names. Trigger recomputes the
                surcharge snapshot on save from the version's
                current material + currency. */}
            <div className="mb-4">
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
                        alt={filename ?? ''}
                        className="mb-2 aspect-square w-full rounded-lg object-contain"
                      />
                      {/* Per-image recipient + side. Designer can
                          correct after the fact on existing images
                          (customer page grouping updates on save). */}
                      <select
                        value={entry.associated_name ?? ''}
                        onChange={(e) => updateAssociatedName(key, e.target.value || null)}
                        className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                        aria-label="Associated name"
                      >
                        <option value="">Shared</option>
                        {names.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <select
                        value={entry.side ?? ''}
                        onChange={(e) => updateSide(key, (e.target.value || null) as 'front' | 'back' | null)}
                        className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-gray-900 focus:outline-none"
                        aria-label="Side"
                      >
                        <option value="">—</option>
                        <option value="front">Front</option>
                        <option value="back">Back</option>
                      </select>
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

          {/* Bottom-of-form mirror of the top action row. Same
              Cancel + Save pair, same form="edit-version-form"
              wiring, so clicking Save here routes through the
              same handleSubmit → validation path as the top
              button. Right-aligned to match the top row's
              visual position within the content column. Not
              sticky — the image-editing section above needs the
              vertical space. */}
          <div className="flex justify-end">
            {actionRow}
          </div>

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
                displayQuantities={displayQuantities}
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
