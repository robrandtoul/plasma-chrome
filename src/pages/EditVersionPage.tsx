import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { PricingDisplay } from '../components/PricingDisplay'
import type { Currency, PricingSnapshot } from '../lib/types'

// ── Image state ────────────────────────────────────────────────────────────────

type EditImage =
  | { kind: 'existing'; id: string; image_path: string; label: string; preview: string }
  | { kind: 'new'; localId: string; file: File; preview: string; label: string }

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
  const [versionNumber, setVersionNumber] = useState(0)
  const [materialDisplay, setMaterialDisplay] = useState('')
  const [inkNames, setInkNames] = useState('')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingSnapshot, setPricingSnapshot] = useState<PricingSnapshot | null>(null)
  const [shippingNote, setShippingNote] = useState('')
  const [featuredQuantities, setFeaturedQuantities] = useState<number[]>([100, 250, 500, 750, 1000])
  const [editImages, setEditImages] = useState<EditImage[]>([])
  const [originalImageIds, setOriginalImageIds] = useState<Set<string>>(new Set())
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragIndexRef = useRef<number | null>(null)

  useEffect(() => {
    if (!proofId || !versionId) return
    loadAll(proofId, versionId)
  }, [proofId, versionId])

  async function loadAll(pid: string, vid: string) {
    const [proofResult, versionResult, imagesResult] = await Promise.all([
      supabase.from('proofs').select('contacts(full_name)').eq('id', pid).single(),
      supabase
        .from('proof_versions')
        .select('version_number, material_display, ink_names, currency, change_notes, pricing_snapshot, shipping_note, materials(featured_quantities)')
        .eq('id', vid)
        .single(),
      supabase
        .from('proof_version_images')
        .select('id, image_path, label, sort_order')
        .eq('proof_version_id', vid)
        .order('sort_order'),
    ])

    if (versionResult.error || !versionResult.data) {
      navigate(`/proofs/${pid}`)
      return
    }

    const c = (proofResult.data?.contacts as any)
    if (c) setProofName(c.full_name ?? '')

    const v = versionResult.data as any
    setVersionNumber(v.version_number)
    setMaterialDisplay(v.material_display)
    setInkNames((v.ink_names as string[]).join(', '))
    setCurrency(v.currency as Currency)
    setChangeNotes(v.change_notes ?? '')
    setPricingSnapshot(v.pricing_snapshot as PricingSnapshot)
    setShippingNote(v.shipping_note)
    setFeaturedQuantities(v.materials?.featured_quantities ?? [100, 250, 500, 750, 1000])

    // Load existing images with signed URLs
    const rawImages = (imagesResult.data ?? []) as { id: string; image_path: string; label: string; sort_order: number }[]
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
          preview: data?.signedUrl ?? '',
        }
      })
    )
    setEditImages(withPreviews)
    setLoading(false)
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFileError('')
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return

    const remaining = MAX_IMAGES - editImages.length
    const toAdd = files.slice(0, remaining)

    const invalidType = toAdd.find((f) => !ACCEPTED_TYPES.includes(f.type))
    const tooLarge = toAdd.find((f) => f.size > MAX_FILE_SIZE)
    if (invalidType) { setFileError('Only JPEG and PNG files are accepted.'); return }
    if (tooLarge) { setFileError('Each file must be 10 MB or smaller.'); return }

    setEditImages((prev) => {
      const currentCount = prev.length
      return [
        ...prev,
        ...toAdd.map((file, i) => ({
          kind: 'new' as const,
          localId: uuidv4(),
          file,
          preview: URL.createObjectURL(file),
          label: defaultLabel(currentCount + i),
        })),
      ]
    })
    if (fileRef.current) fileRef.current.value = ''
  }

  function removeImage(key: string) {
    setEditImages((prev) =>
      prev.filter((img) => {
        if (img.kind === 'existing') return img.id !== key
        if (img.kind === 'new') {
          if (img.localId === key) { URL.revokeObjectURL(img.preview); return false }
        }
        return true
      })
    )
  }

  function updateLabel(key: string, label: string) {
    setEditImages((prev) =>
      prev.map((img) => {
        if (img.kind === 'existing' && img.id === key) return { ...img, label }
        if (img.kind === 'new' && img.localId === key) return { ...img, label }
        return img
      })
    )
  }

  function handleDragStart(index: number) {
    dragIndexRef.current = index
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || from === index) return
    setEditImages((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(index, 0, item)
      return next
    })
    dragIndexRef.current = index
  }

  function handleDragEnd() {
    dragIndexRef.current = null
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')

    if (editImages.length === 0) { setError('Please add at least one proof image.'); return }
    if (!materialDisplay.trim()) { setError('Material display name cannot be empty.'); return }

    setSubmitting(true)

    // Upload new images
    const uploadResults = await Promise.all(
      editImages
        .filter((img): img is Extract<EditImage, { kind: 'new' }> => img.kind === 'new')
        .map(async (entry) => {
          const ext = entry.file.type === 'image/png' ? 'png' : 'jpg'
          const path = `${proofId}/${uuidv4()}.${ext}`
          const { error: uploadError } = await supabase.storage
            .from('proof-images')
            .upload(path, entry.file, { contentType: entry.file.type, upsert: false })
          return { localId: entry.localId, path, error: uploadError }
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

    // Determine removed existing images
    const remainingExistingIds = new Set(
      editImages.filter((img): img is Extract<EditImage, { kind: 'existing' }> => img.kind === 'existing').map((img) => img.id)
    )
    const removedIds = [...originalImageIds].filter((id) => !remainingExistingIds.has(id))

    // Fetch image_paths of removed images so we can delete from storage
    let removedPaths: string[] = []
    if (removedIds.length > 0) {
      const { data: removedRows } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('id', removedIds)
      removedPaths = (removedRows ?? []).map((r: any) => r.image_path)
    }

    // Update proof_versions (pricing_snapshot is intentionally excluded — immutable)
    const { error: updateErr } = await supabase
      .from('proof_versions')
      .update({
        material_display: materialDisplay.trim(),
        ink_names: inkNames.split(',').map((s) => s.trim()).filter(Boolean),
        change_notes: changeNotes.trim() || null,
      })
      .eq('id', versionId!)

    if (updateErr) {
      setError(`Failed to save: ${updateErr.message}`)
      setSubmitting(false)
      return
    }

    // Delete removed image rows
    if (removedIds.length > 0) {
      await supabase.from('proof_version_images').delete().in('id', removedIds)
      if (removedPaths.length > 0) {
        await supabase.storage.from('proof-images').remove(removedPaths)
      }
    }

    // Update existing image rows (label + sort_order may have changed)
    await Promise.all(
      editImages
        .filter((img): img is Extract<EditImage, { kind: 'existing' }> => img.kind === 'existing')
        .map((img, _i) => {
          const sortOrder = editImages.findIndex((x) => x.kind === 'existing' && x.id === img.id)
          return supabase
            .from('proof_version_images')
            .update({ label: img.label, sort_order: sortOrder })
            .eq('id', img.id)
        })
    )

    // Insert new image rows
    const newImageInserts = editImages
      .map((img, i) => {
        if (img.kind !== 'new') return null
        const path = uploadedPathByLocalId[img.localId]
        if (!path) return null
        return {
          proof_version_id: versionId!,
          image_path: path,
          label: img.label,
          sort_order: i,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

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
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to proof</Link>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-gray-900">Edit v{versionNumber}</h1>
        {proofName && <p className="mb-8 text-gray-500">{proofName}</p>}

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Images */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">
              Proof images
              {editImages.length > 0 && (
                <span className="ml-2 font-normal normal-case text-gray-400">— drag to reorder</span>
              )}
            </h2>

            {editImages.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {editImages.map((entry, index) => {
                  const key = entry.kind === 'existing' ? entry.id : entry.localId
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

            {editImages.length < MAX_IMAGES && (
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
                  className="flex w-full items-center justify-center rounded-xl border-2 border-dashed border-gray-200 py-8 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600"
                >
                  {editImages.length === 0
                    ? 'Click to upload JPEG or PNG (max 10 MB each)'
                    : `Add more images (${editImages.length} / ${MAX_IMAGES})`}
                </button>
              </>
            )}

            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
          </section>

          {/* Specification */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Material display name</label>
              <input
                type="text"
                value={materialDisplay}
                onChange={(e) => setMaterialDisplay(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Ink names <span className="font-normal text-gray-400">(optional, comma-separated)</span>
              </label>
              <input
                type="text"
                value={inkNames}
                onChange={(e) => setInkNames(e.target.value)}
                placeholder="e.g. Pantone 185 C, Metallic Gold"
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Currency</label>
              <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                {currency} <span className="text-gray-400">(cannot be changed after creation)</span>
              </p>
            </div>
          </section>

          {/* Pricing — read-only */}
          {pricingSnapshot && (
            <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Pricing</h2>
                <span className="text-xs text-gray-400">Read-only — locked at creation</span>
              </div>
              <PricingDisplay
                snapshot={pricingSnapshot}
                currency={currency}
                featuredQuantities={featuredQuantities}
              />
              <div className="border-t border-gray-100 px-6 py-3">
                <p className="text-xs text-gray-400">{shippingNote}</p>
              </div>
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

          {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

          <div className="flex gap-3">
            <Link
              to={`/proofs/${proofId}`}
              className="flex-1 rounded-lg px-4 py-3 text-center text-sm font-semibold text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-lg bg-gray-900 px-4 py-3 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
