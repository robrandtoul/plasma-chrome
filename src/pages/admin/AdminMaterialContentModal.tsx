import { useEffect, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import type { KeyFeature } from '../../lib/types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MaterialContent {
  id: string
  code: string
  display_name: string
  category: Category
  description: string | null
  icon_url: string | null
  is_published: boolean
  /** Null means active. Timestamp means soft-archived. */
  archived_at: string | null
  // ── Customer-facing pricing presentation (migration 000095) ───────────
  // Curated display list for the customer pricing table. Null
  // means not yet curated; customer page falls back to the first
  // 10 tiers ascending from the version's pricing snapshot.
  display_quantities: number[] | null
  // Quote-range bounds for the customer's quantity lookup input.
  // Null on either side = unbounded on that side.
  quote_min_quantity: number | null
  quote_max_quantity: number | null
  // ── Key features (migration 000100) ──────────────────────────────────
  // Curated {title, body} pairs surfaced on the customer About
  // section as a numbered editorial list. Null or empty means
  // not yet curated; customer render hides the block cleanly.
  key_features: KeyFeature[] | null
  // ── Personalisation eligibility (migration 000172) ───────────────────
  // True iff this material can carry the personalisation add-on.
  // Combined with card_type='membership' on the version form to
  // decide whether to render the "Add personalisation" checkbox.
  supports_personalisation: boolean
}

// Kept in sync with the CHECK constraint on materials.category installed
// by 000009_rebuild_pricing.
export type Category = 'metal' | 'plastic' | 'paper' | 'wood' | 'carbon_fibre' | 'acrylic'

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: 'metal',        label: 'Metal' },
  { value: 'plastic',      label: 'Plastic' },
  { value: 'paper',        label: 'Paper' },
  { value: 'wood',         label: 'Wood' },
  { value: 'carbon_fibre', label: 'Carbon fibre' },
  { value: 'acrylic',      label: 'Acrylic' },
]

const ACCEPTED = ['image/png', 'image/jpeg', 'image/svg+xml']
const MAX_SIZE = 2 * 1024 * 1024

// Soft-only bounds for key_features editing. Over-length shows an
// amber warning beneath the field; doesn't block save. 1.5x the
// current seed content's max length (title 34, body 76 as at
// migration 000100). Cap of 8 features mirrors the customer page's
// numbered render — beyond that becomes visual noise.
const TITLE_SOFT_MAX = 50
const BODY_SOFT_MAX = 120
const MAX_FEATURES = 8

// Deep-equality for an array of {title, body} pairs. Used by the
// save guard to skip DB writes on no-op blurs. Inline rather than
// pulling in a dep — the comparison is tiny and honest.
function keyFeaturesEqual(a: KeyFeature[] | null, b: KeyFeature[] | null): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].title !== b[i].title || a[i].body !== b[i].body) return false
  }
  return true
}

// Pull the "foo.png" tail out of a Supabase public URL so we can delete
// the file when the icon is replaced or removed.
function pathFromPublicUrl(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/storage\/v1\/object\/public\/material-icons\/(.+)$/)
  return match?.[1] ?? null
}

function extFromFile(file: File): string {
  if (file.type === 'image/svg+xml') return 'svg'
  if (file.type === 'image/jpeg') return 'jpg'
  return 'png'
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminMaterialContentModal({ material, onClose, onSaved }: {
  material: MaterialContent
  onClose: () => void
  onSaved: (updated: MaterialContent) => void
}) {
  const [draftName, setDraftName] = useState(material.display_name)
  const [draftCategory, setDraftCategory] = useState<Category>(material.category)
  const [draftDesc, setDraftDesc] = useState(material.description ?? '')
  const [currentIconUrl, setCurrentIconUrl] = useState(material.icon_url)
  const [isPublished, setIsPublished] = useState(material.is_published)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [publishInFlight, setPublishInFlight] = useState(false)
  const [publishConfirm, setPublishConfirm] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [archivedAt, setArchivedAt] = useState<string | null>(material.archived_at)
  const [archiveInFlight, setArchiveInFlight] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [unarchiveNotice, setUnarchiveNotice] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Display list + quote bounds (migration 000095). Three new
  // auto-save-on-blur fields. The display_quantities draft is
  // stored as the comma-or-space-separated string the admin is
  // typing; it's parsed on blur into a sorted-ascending deduped
  // int[] for the save. quoteMin / quoteMax drafts are strings so
  // we can distinguish "" (meaning null) from "0" (rejected as
  // invalid). Parsed on blur.
  const [draftDisplayQtys, setDraftDisplayQtys] = useState(
    (material.display_quantities ?? []).join(', '),
  )
  const [draftQuoteMin, setDraftQuoteMin] = useState(
    material.quote_min_quantity == null ? '' : String(material.quote_min_quantity),
  )
  const [draftQuoteMax, setDraftQuoteMax] = useState(
    material.quote_max_quantity == null ? '' : String(material.quote_max_quantity),
  )
  const [displayQtysError, setDisplayQtysError] = useState<string | null>(null)
  const [quoteMinError, setQuoteMinError] = useState<string | null>(null)
  const [quoteMaxError, setQuoteMaxError] = useState<string | null>(null)

  // Key features draft + error (migration 000100). Whole-array
  // auto-save on any row blur; remove-row saves immediately.
  // Draft holds raw (un-trimmed) user text so admins can type
  // freely; save-time normalises via trim + filter-empty.
  const [draftFeatures, setDraftFeatures] = useState<KeyFeature[]>(
    material.key_features ?? [],
  )
  const [featuresError, setFeaturesError] = useState<string | null>(null)
  // Personalisation eligibility (migration 000172). Toggle. Save
  // fires immediately on change; uses the same direct-update +
  // audit-log pattern as the publish toggle.
  const [supportsPersonalisation, setSupportsPersonalisation] = useState(
    material.supports_personalisation,
  )
  const [supportsPersonalisationError, setSupportsPersonalisationError] = useState<string | null>(null)
  const [supportsPersonalisationInFlight, setSupportsPersonalisationInFlight] = useState(false)
  // Index of the row just added via "Add feature", so its title
  // input can auto-focus on the next render. Cleared after focus
  // fires so a later unrelated render doesn't steal focus.
  const [pendingFocusIdx, setPendingFocusIdx] = useState<number | null>(null)
  const featureTitleRefs = useRef<Map<number, HTMLInputElement>>(new Map())
  useEffect(() => {
    if (pendingFocusIdx == null) return
    const input = featureTitleRefs.current.get(pendingFocusIdx)
    if (input) { input.focus(); setPendingFocusIdx(null) }
  }, [pendingFocusIdx, draftFeatures])

  // Esc handling owned by Modal; preventClose wired to `saving`
  // to block Esc / backdrop dismissal during in-flight saves.

  async function saveName() {
    const trimmed = draftName.trim()
    if (trimmed === material.display_name) { setNameError(null); return }
    if (trimmed === '') {
      setNameError('Name is required.')
      setDraftName(material.display_name)
      return
    }

    // Client-side duplicate check (case-insensitive). The DB unique
    // index is the source of truth; this just gives a friendlier error
    // before we issue the UPDATE.
    const { data: dupes } = await supabase
      .from('materials')
      .select('id')
      .ilike('display_name', trimmed)
      .neq('id', material.id)
      .limit(1)
    if (dupes && dupes.length > 0) {
      setNameError('A material with this name already exists.')
      setDraftName(material.display_name)
      return
    }

    setSaving(true)
    setNameError(null)
    const prev = material.display_name
    const { error: err } = await supabase
      .from('materials')
      .update({ display_name: trimmed })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      // Unique-index violation from the DB (race condition).
      if (err.code === '23505') {
        setNameError('A material with this name already exists.')
      } else {
        setNameError(`Failed to rename: ${err.message}`)
      }
      setDraftName(prev)
      return
    }
    setSavedAt(Date.now())
    material.display_name = trimmed
    onSaved({ ...material })
    void logAudit({
      action: 'material.name_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: trimmed,
      beforeValue: { display_name: prev },
      afterValue: { display_name: trimmed },
    })
  }

  async function saveCategory(next: Category) {
    if (next === material.category) return
    if (!CATEGORY_OPTIONS.some((o) => o.value === next)) {
      setError('Invalid category.')
      setDraftCategory(material.category)
      return
    }
    setSaving(true)
    setError(null)
    const prev = material.category
    const { error: err } = await supabase
      .from('materials')
      .update({ category: next })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setError(`Failed to save category: ${err.message}`)
      setDraftCategory(prev)
      return
    }
    setSavedAt(Date.now())
    material.category = next
    onSaved({ ...material })
    void logAudit({
      action: 'material.category_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { category: prev },
      afterValue: { category: next },
    })
  }

  async function saveDescription() {
    const trimmed = draftDesc.trim() === '' ? null : draftDesc
    if (trimmed === material.description) return
    setSaving(true)
    setError(null)
    const prev = material.description
    const { error: err } = await supabase
      .from('materials')
      .update({ description: trimmed })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setError(`Failed to save description: ${err.message}`)
      setDraftDesc(prev ?? '')
      return
    }
    setSavedAt(Date.now())
    material.description = trimmed
    onSaved({ ...material })
    void logAudit({
      action: 'material.description_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { description: prev },
      afterValue: { description: trimmed },
    })
  }

  // Parse the display-quantities text field into a sorted-
  // ascending deduped int[]. Returns:
  //   { ok: true, parsed: [], canonical: '' }     — empty (save as null)
  //   { ok: true, parsed: [...], canonical: '…' } — valid ints
  //   { ok: false, reason: '...' }                — invalid
  // Accepts comma AND whitespace separators so "100, 250 500"
  // works. Rejects non-numeric tokens, zero, and negatives; silently
  // dedupes and sorts so the admin doesn't need to worry about
  // order or duplicates.
  function parseDisplayQuantities(raw: string): (
    | { ok: true; parsed: number[]; canonical: string }
    | { ok: false; reason: string }
  ) {
    const trimmed = raw.trim()
    if (trimmed === '') return { ok: true, parsed: [], canonical: '' }
    const tokens = trimmed.split(/[,\s]+/).filter((s) => s.length > 0)
    const seen = new Set<number>()
    const bad: string[] = []
    for (const tok of tokens) {
      if (!/^\d+$/.test(tok)) { bad.push(tok); continue }
      const n = parseInt(tok, 10)
      if (!Number.isFinite(n) || n <= 0) { bad.push(tok); continue }
      seen.add(n)
    }
    if (bad.length > 0) {
      return {
        ok: false,
        reason: `Could not read as positive integers: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}.`,
      }
    }
    const sorted = [...seen].sort((a, b) => a - b)
    return { ok: true, parsed: sorted, canonical: sorted.join(', ') }
  }

  // Parse a single bound (quote_min / quote_max) input. Blank → null
  // (unbounded). Non-integer / non-positive → error.
  function parseBound(raw: string): (
    | { ok: true; value: number | null }
    | { ok: false; reason: string }
  ) {
    const trimmed = raw.trim()
    if (trimmed === '') return { ok: true, value: null }
    if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'Whole number only.' }
    const n = parseInt(trimmed, 10)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'Must be greater than zero.' }
    return { ok: true, value: n }
  }

  async function saveDisplayQuantities() {
    const result = parseDisplayQuantities(draftDisplayQtys)
    if (!result.ok) { setDisplayQtysError(result.reason); return }
    // Re-normalise the draft to the canonical form so the admin
    // sees "100, 250, 500" even if they typed "500 100 250".
    setDraftDisplayQtys(result.canonical)
    setDisplayQtysError(null)
    const next: number[] | null = result.parsed.length === 0 ? null : result.parsed
    const prev = material.display_quantities
    // Arrays compared by deep equality (same length + same elements).
    const unchanged =
      (prev == null && next == null) ||
      (prev != null && next != null && prev.length === next.length && prev.every((v, i) => v === next[i]))
    if (unchanged) return
    setSaving(true)
    const { error: err } = await supabase
      .from('materials')
      .update({ display_quantities: next })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setDisplayQtysError(`Failed to save: ${err.message}`)
      setDraftDisplayQtys((prev ?? []).join(', '))
      return
    }
    material.display_quantities = next
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.display_quantities_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { display_quantities: prev },
      afterValue: { display_quantities: next },
    })
  }

  async function saveQuoteMinQuantity() {
    const result = parseBound(draftQuoteMin)
    if (!result.ok) { setQuoteMinError(result.reason); return }
    const next = result.value
    // Cross-field validation — if max is set and non-null next
    // would exceed it, refuse the save with an inline error.
    const maxResult = parseBound(draftQuoteMax)
    if (maxResult.ok && maxResult.value != null && next != null && next > maxResult.value) {
      setQuoteMinError('Must be less than or equal to the maximum.')
      return
    }
    setQuoteMinError(null)
    if (next === material.quote_min_quantity) return
    setSaving(true)
    const prev = material.quote_min_quantity
    const { error: err } = await supabase
      .from('materials')
      .update({ quote_min_quantity: next })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setQuoteMinError(`Failed to save: ${err.message}`)
      setDraftQuoteMin(prev == null ? '' : String(prev))
      return
    }
    material.quote_min_quantity = next
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.quote_min_quantity_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { quote_min_quantity: prev },
      afterValue: { quote_min_quantity: next },
    })
  }

  async function saveQuoteMaxQuantity() {
    const result = parseBound(draftQuoteMax)
    if (!result.ok) { setQuoteMaxError(result.reason); return }
    const next = result.value
    const minResult = parseBound(draftQuoteMin)
    if (minResult.ok && minResult.value != null && next != null && next < minResult.value) {
      setQuoteMaxError('Must be greater than or equal to the minimum.')
      return
    }
    setQuoteMaxError(null)
    if (next === material.quote_max_quantity) return
    setSaving(true)
    const prev = material.quote_max_quantity
    const { error: err } = await supabase
      .from('materials')
      .update({ quote_max_quantity: next })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setQuoteMaxError(`Failed to save: ${err.message}`)
      setDraftQuoteMax(prev == null ? '' : String(prev))
      return
    }
    material.quote_max_quantity = next
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.quote_max_quantity_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { quote_max_quantity: prev },
      afterValue: { quote_max_quantity: next },
    })
  }

  async function saveSupportsPersonalisation(next: boolean) {
    if (next === material.supports_personalisation) return
    setSupportsPersonalisationInFlight(true)
    setSupportsPersonalisationError(null)
    const prev = material.supports_personalisation
    setSupportsPersonalisation(next)
    const { error: err } = await supabase
      .from('materials')
      .update({ supports_personalisation: next })
      .eq('id', material.id)
    setSupportsPersonalisationInFlight(false)
    if (err) {
      setSupportsPersonalisation(prev)
      setSupportsPersonalisationError(`Failed to save: ${err.message}`)
      return
    }
    material.supports_personalisation = next
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.supports_personalisation_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { supports_personalisation: prev },
      afterValue: { supports_personalisation: next },
    })
  }

  // ── Key features editor helpers ──────────────────────────────────────
  //
  // Draft state is liberal (admin can leave an empty row while
  // typing). Commit state is tight: saveKeyFeatures trims and
  // filters empty rows before writing. Whole-array save on any
  // field blur; remove-row saves immediately because state is
  // stable at click time.

  function updateFeature(idx: number, field: 'title' | 'body', value: string) {
    setDraftFeatures((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  function addFeature() {
    setDraftFeatures((prev) => {
      if (prev.length >= MAX_FEATURES) return prev
      const nextIdx = prev.length
      // Schedule focus to land on the new row's title input on
      // the next render (when the input exists in the DOM).
      setPendingFocusIdx(nextIdx)
      return [...prev, { title: '', body: '' }]
    })
    // No save yet — empty rows are invalid and would be filtered
    // out. Save fires when the admin blurs away from the new row.
  }

  async function removeFeature(idx: number) {
    // Build the next draft synchronously so we can both update
    // state and commit in one pass (the setState below is
    // asynchronous, so we pass the computed value into save).
    const nextDraft = draftFeatures.filter((_, i) => i !== idx)
    setDraftFeatures(nextDraft)
    await saveKeyFeatures(nextDraft)
  }

  // Reorder by swapping with the neighbour. dir=-1 moves the row
  // earlier (Up), dir=+1 moves it later (Down). Bounds-guarded;
  // a no-op call from a disabled-state misclick is harmless.
  // Saves immediately with the explicit nextDraft to avoid the
  // React state async gap, same pattern as removeFeature.
  async function moveFeature(idx: number, dir: -1 | 1) {
    const swapWith = idx + dir
    if (swapWith < 0 || swapWith >= draftFeatures.length) return
    const nextDraft = [...draftFeatures]
    ;[nextDraft[idx], nextDraft[swapWith]] = [nextDraft[swapWith], nextDraft[idx]]
    setDraftFeatures(nextDraft)
    await saveKeyFeatures(nextDraft)
  }

  async function saveKeyFeatures(explicit?: KeyFeature[]) {
    // Source of truth: explicit arg (from removeFeature) or
    // current draft state (from input blurs).
    const source = explicit ?? draftFeatures
    const trimmed: KeyFeature[] = source
      .map((f) => ({ title: f.title.trim(), body: f.body.trim() }))
      .filter((f) => f.title.length > 0 && f.body.length > 0)

    // Empty array saves as null — matches the customer render
    // gate (`key_features && length > 0`). Keeps DB state clean
    // too: null means "not curated", empty array means nothing.
    const next: KeyFeature[] | null = trimmed.length === 0 ? null : trimmed
    const prev = material.key_features

    if (keyFeaturesEqual(prev, next)) { setFeaturesError(null); return }

    setSaving(true)
    const { error: err } = await supabase
      .from('materials')
      .update({ key_features: next })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setFeaturesError(`Failed to save: ${err.message}`)
      return
    }
    setFeaturesError(null)
    material.key_features = next
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.key_features_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { key_features: prev },
      afterValue: { key_features: next },
    })
  }

  async function handleFile(file: File) {
    if (!ACCEPTED.includes(file.type)) { setError('Use PNG, JPG, or SVG.'); return }
    if (file.size > MAX_SIZE) { setError('Icon must be 2 MB or less.'); return }
    setError(null)
    setSaving(true)

    const ext = extFromFile(file)
    const path = `${material.code}.${ext}`

    // Upload (upsert so the same slug always overwrites).
    const { error: upErr } = await supabase.storage
      .from('material-icons')
      .upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) {
      setSaving(false)
      setError(`Upload failed: ${upErr.message}`)
      return
    }

    // Clean up any stale icon at a different extension (e.g. old PNG
    // when we just uploaded a JPG). Cheap and only the extension pool
    // to scan.
    const priorPath = pathFromPublicUrl(currentIconUrl)
    if (priorPath && priorPath !== path) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }

    const { data: pub } = supabase.storage.from('material-icons').getPublicUrl(path)
    // Cache-bust so the browser picks up the new file straight away.
    const url = `${pub.publicUrl}?v=${Date.now()}`

    const { error: updErr } = await supabase
      .from('materials')
      .update({ icon_url: url })
      .eq('id', material.id)
    setSaving(false)
    if (updErr) {
      setError(`Failed to save icon URL: ${updErr.message}`)
      return
    }
    setCurrentIconUrl(url)
    material.icon_url = url
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.icon_uploaded',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      metadata: { filename: file.name, size_kb: Math.round(file.size / 1024), path },
    })
  }

  async function handleRemoveIcon() {
    if (!currentIconUrl) return
    setSaving(true)
    setError(null)
    const priorPath = pathFromPublicUrl(currentIconUrl)
    const prevUrl = currentIconUrl
    if (priorPath) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }
    const { error: err } = await supabase
      .from('materials')
      .update({ icon_url: null })
      .eq('id', material.id)
    setSaving(false)
    if (err) { setError(`Failed to clear icon: ${err.message}`); return }
    setCurrentIconUrl(null)
    material.icon_url = null
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.icon_removed',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      metadata: { previous_url: prevUrl },
    })
  }

  // ── Publish / unpublish ───────────────────────────────────────────────
  //
  // Unpublish is always immediate. Publish runs two cheap COUNT queries
  // first — if the material has no active variants or no price tiers,
  // show a soft "Publish anyway?" confirm so the admin can back out.
  async function onPublishClick() {
    setPublishError(null)
    if (isPublished) { void applyPublishChange(false); return }

    setPublishInFlight(true)
    try {
      const [variantsCount, tiersCount] = await Promise.all([
        supabase
          .from('material_variants')
          .select('id', { count: 'exact', head: true })
          .eq('material_id', material.id)
          .eq('is_active', true),
        supabase
          .from('price_tiers')
          .select('id, material_variants!inner(material_id)', { count: 'exact', head: true })
          .eq('material_variants.material_id', material.id),
      ])
      const variantN = variantsCount.count ?? 0
      const tierN = tiersCount.count ?? 0
      if (variantN === 0 || tierN === 0) {
        setPublishConfirm(true)
        setPublishInFlight(false)
        return
      }
      await applyPublishChange(true)
    } catch (e) {
      setPublishError((e as Error).message)
      setPublishInFlight(false)
    }
  }

  async function applyPublishChange(next: boolean) {
    setPublishInFlight(true)
    setPublishError(null)
    try {
      const { error: err } = await supabase
        .from('materials')
        .update({ is_published: next })
        .eq('id', material.id)
      if (err) throw new Error(err.message)
      setIsPublished(next)
      material.is_published = next
      onSaved({ ...material })
      setSavedAt(Date.now())
      setPublishConfirm(false)
      void logAudit({
        action: next ? 'material_published' : 'material_unpublished',
        targetType: 'material',
        targetId: material.id,
        targetLabel: material.display_name,
        beforeValue: { is_published: !next },
        afterValue: { is_published: next },
      })
    } catch (e) {
      setPublishError((e as Error).message)
    } finally {
      setPublishInFlight(false)
    }
  }

  // ── Archive / unarchive (Phase 4) ─────────────────────────────────────
  //
  // Archive auto-unpublishes in the same UPDATE so we can't leave the
  // material archived-but-visible. Unarchive leaves is_published alone
  // (admins must re-publish explicitly — see the Phase 4 spec).

  function requestArchive() {
    setArchiveError(null)
    setArchiveConfirm(true)
  }

  async function applyArchive() {
    const wasPublished = isPublished
    setArchiveInFlight(true)
    setArchiveError(null)
    try {
      const now = new Date().toISOString()
      const { error: err } = await supabase
        .from('materials')
        .update({ archived_at: now, is_published: false })
        .eq('id', material.id)
      if (err) throw new Error(err.message)
      // Optimistic state so onSaved propagates the new values even
      // though we close the modal immediately after.
      setArchivedAt(now)
      setIsPublished(false)
      material.archived_at = now
      material.is_published = false
      onSaved({ ...material })
      void logAudit({
        action: 'material_archived',
        targetType: 'material',
        targetId: material.id,
        targetLabel: material.display_name,
        beforeValue: { archived_at: null, is_published: wasPublished },
        afterValue: { archived_at: now, is_published: false },
        metadata: { was_published: wasPublished },
      })
      setArchiveConfirm(false)
      // Archive is destructive enough that closing the modal feels
      // right — the admin's attention should go back to the Settings
      // list so they can confirm the row has moved.
      onClose()
    } catch (e) {
      setArchiveError((e as Error).message)
    } finally {
      setArchiveInFlight(false)
    }
  }

  async function applyUnarchive() {
    setArchiveInFlight(true)
    setArchiveError(null)
    try {
      const { error: err } = await supabase
        .from('materials')
        .update({ archived_at: null })
        .eq('id', material.id)
      if (err) throw new Error(err.message)
      setArchivedAt(null)
      material.archived_at = null
      onSaved({ ...material })
      setUnarchiveNotice(true)
      window.setTimeout(() => setUnarchiveNotice(false), 5000)
      void logAudit({
        action: 'material_unarchived',
        targetType: 'material',
        targetId: material.id,
        targetLabel: material.display_name,
        beforeValue: { archived_at: material.archived_at ?? 'previous' },
        afterValue: { archived_at: null },
      })
    } catch (e) {
      setArchiveError((e as Error).message)
    } finally {
      setArchiveInFlight(false)
    }
  }

  const isArchived = archivedAt != null
  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <>
      <Modal
        open
        onClose={onClose}
        preventClose={saving}
        ariaLabelledBy="material-content-title"
        panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl"
      >
          {/* Header */}
          <div className="flex items-start justify-between border-b border-line-soft px-6 py-4">
            <div>
              <h3 id="material-content-title" className="text-lg font-semibold text-ink">{draftName.trim() || material.display_name}</h3>
              <Link
                to={`/admin/pricing/materials/${material.code}`}
                className="text-xs text-ink-mute hover:text-ink hover:underline"
              >
                Open pricing editor →
              </Link>
            </div>
            <div className="flex items-center gap-3">
              {saving && <span className="text-xs text-ink-dim">Saving…</span>}
              {recentlySaved && !saving && <span className="text-xs text-in-stock">Saved</span>}
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-ink-dim hover:bg-canvas hover:text-ink-soft"
                aria-label="Close"
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="space-y-6 overflow-y-auto px-6 py-5">
            {/* Name */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                Material name <span className="text-out">*</span>
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => { setDraftName(e.target.value); if (nameError) setNameError(null) }}
                onBlur={saveName}
                className={[
                  'w-full rounded border px-3 py-2 text-[17px] sm:text-sm focus:outline-none',
                  nameError
                    ? 'border-out focus:border-[var(--c-out)] focus:bg-[var(--c-out-soft)]'
                    : 'border-line focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)]',
                ].join(' ')}
              />
              <p className="mt-1.5 text-xs text-ink-mute">
                This is what customers and designers see. The internal identifier (slug) won't change.
              </p>
              {nameError && (
                <p className="mt-1.5 text-xs font-medium text-out">{nameError}</p>
              )}
            </section>

            {/* Category */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                Category <span className="text-out">*</span>
              </label>
              <select
                value={draftCategory}
                onChange={(e) => {
                  const next = e.target.value as Category
                  setDraftCategory(next)
                  void saveCategory(next)
                }}
                className="w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
              >
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-ink-mute">
                Groups this material in the designer's dropdown.
              </p>
            </section>

            {/* Description */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Description</label>
              <textarea
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                onBlur={saveDescription}
                rows={6}
                className="w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                placeholder="e.g. Steel cards are 0.5mm thick and laser-cut to…"
              />
              <p className="mt-1.5 text-xs text-ink-mute">
                Displayed on the customer-facing proof page for any proof using this material. Paragraph breaks render as spacing.
              </p>
            </section>

            {/* Key features (migration 000100) — curated
                {title, body} pairs surfaced on the customer
                About section as a numbered editorial list.
                Whole-array auto-save on any row blur; remove
                triggers immediate save. Empty array normalises
                to null on save for parity with the customer
                render gate. */}
            <section>
              <h4 className="mb-3 text-sm font-semibold text-ink">Key features</h4>
              <p className="mb-4 text-xs text-ink-mute">
                Surfaced on the customer proof page under the About section, numbered 01 to {draftFeatures.length.toString().padStart(2, '0')} in the order shown here. Each feature is a short title plus a one-line supporting description.
              </p>

              {draftFeatures.length === 0 && (
                <p className="mb-3 text-sm text-ink-mute">
                  No features yet. Click "Add feature" to start.
                </p>
              )}

              <ol className="space-y-3">
                {draftFeatures.map((feature, i) => {
                  const titleOver = feature.title.length > TITLE_SOFT_MAX
                  const bodyOver = feature.body.length > BODY_SOFT_MAX
                  return (
                    <li
                      key={i}
                      className="grid grid-cols-[32px_1fr_auto] items-start gap-3 rounded-lg border border-line p-3"
                    >
                      {/* Plain gray sans-serif numeral — admin chrome tone. */}
                      <span className="pt-2 text-sm font-semibold text-ink-dim tabular-nums">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0 space-y-2">
                        <input
                          ref={(el) => {
                            if (el) featureTitleRefs.current.set(i, el)
                            else featureTitleRefs.current.delete(i)
                          }}
                          type="text"
                          value={feature.title}
                          onChange={(e) => updateFeature(i, 'title', e.target.value)}
                          onBlur={() => { void saveKeyFeatures() }}
                          placeholder="Title (e.g. Rolled stainless steel)"
                          className="w-full rounded border border-line px-2 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                        <input
                          type="text"
                          value={feature.body}
                          onChange={(e) => updateFeature(i, 'body', e.target.value)}
                          onBlur={() => { void saveKeyFeatures() }}
                          placeholder="Supporting line (e.g. Precision etched from sheet metal…)"
                          className="w-full rounded border border-line px-2 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                        {(titleOver || bodyOver) && (
                          <p className="text-xs text-low">
                            {titleOver && `Title over ${TITLE_SOFT_MAX} chars may crowd the customer layout.`}
                            {titleOver && bodyOver && ' '}
                            {bodyOver && `Body over ${BODY_SOFT_MAX} chars may wrap awkwardly.`}
                          </p>
                        )}
                      </div>
                      {/* Action buttons grouped — Up / Down /
                          Remove, equal weight, small. Up is
                          disabled on the first row, Down on the
                          last. Disabled treatment matches the
                          Add-feature button: opacity-50 +
                          cursor-not-allowed. Unicode arrows
                          since lucide-react isn't in the deps;
                          the glyphs read at admin chrome scale
                          without needing a webfont. */}
                      <div className="flex items-start gap-1">
                        <button
                          type="button"
                          onClick={() => { void moveFeature(i, -1) }}
                          disabled={i === 0}
                          className="rounded px-2 py-1 text-xs font-medium text-ink-dim hover:bg-canvas hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-dim"
                          aria-label={`Move feature ${i + 1} up`}
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => { void moveFeature(i, 1) }}
                          disabled={i === draftFeatures.length - 1}
                          className="rounded px-2 py-1 text-xs font-medium text-ink-dim hover:bg-canvas hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-dim"
                          aria-label={`Move feature ${i + 1} down`}
                          title="Move down"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => { void removeFeature(i) }}
                          className="rounded px-2 py-1 text-xs font-medium text-ink-dim hover:bg-out-soft hover:text-out"
                          aria-label={`Remove feature ${i + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ol>

              <button
                type="button"
                onClick={addFeature}
                disabled={draftFeatures.length >= MAX_FEATURES}
                className="mt-3 text-sm font-medium text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Add feature{draftFeatures.length >= MAX_FEATURES && ' (max reached)'}
              </button>

              {featuresError && (
                <p className="mt-2 text-xs text-out">{featuresError}</p>
              )}
            </section>

            {/* Pricing presentation (migration 000095) — curated
                display list + quote-range bounds. Three related
                inputs grouped so the admin treats them as a unit
                when deciding how this material shows up on the
                customer page. */}
            <section>
              <h4 className="mb-3 text-sm font-semibold text-ink">Pricing presentation</h4>

              {/* Display quantities */}
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Display quantities</label>
              <input
                type="text"
                value={draftDisplayQtys}
                onChange={(e) => { setDraftDisplayQtys(e.target.value); setDisplayQtysError(null) }}
                onBlur={saveDisplayQuantities}
                placeholder="e.g. 100, 250, 500, 1000"
                className="w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
              />
              {/* Preview / status line — green when parsed cleanly,
                  rose on error. Both colours use the same position
                  so the admin always looks to the same spot for
                  feedback. */}
              {displayQtysError ? (
                <p className="mt-1.5 text-xs text-out">{displayQtysError}</p>
              ) : (() => {
                // Live preview without committing. Mirrors saveDisplayQuantities'
                // parse so what the admin sees matches what will save.
                const preview = parseDisplayQuantities(draftDisplayQtys)
                if (!preview.ok) return null
                if (preview.parsed.length === 0) {
                  return (
                    <p className="mt-1.5 text-xs text-ink-mute">
                      Preview: empty. Customer page will fall back to the first 10 tiers in the pricing snapshot.
                    </p>
                  )
                }
                return (
                  <p className="mt-1.5 text-xs text-ink-mute">
                    Preview: {preview.parsed.map((n) => n.toLocaleString()).join(', ')}
                  </p>
                )
              })()}
              <p className="mt-1 text-xs text-ink-dim">
                Comma or space separated. Customer page shows these rows (intersected with the snapshot) on the single pricing table. Leave blank to fall back to the first 10 tiers in the snapshot.
              </p>

              {/* Quote bounds — side-by-side on wide widths,
                  stacked on narrow. Both optional. */}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink-soft">Minimum quantity for quote</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={draftQuoteMin}
                    onChange={(e) => { setDraftQuoteMin(e.target.value); setQuoteMinError(null) }}
                    onBlur={saveQuoteMinQuantity}
                    placeholder="Leave blank for no minimum"
                    className="w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                  />
                  {quoteMinError && (
                    <p className="mt-1.5 text-xs text-out">{quoteMinError}</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink-soft">Maximum quantity for quote</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={draftQuoteMax}
                    onChange={(e) => { setDraftQuoteMax(e.target.value); setQuoteMaxError(null) }}
                    onBlur={saveQuoteMaxQuantity}
                    placeholder="Leave blank for no maximum"
                    className="w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                  />
                  {quoteMaxError && (
                    <p className="mt-1.5 text-xs text-out">{quoteMaxError}</p>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-ink-dim">
                Bound the customer's quantity-lookup input. Typing a value outside the range returns a "please get in touch" message instead of a tier row.
              </p>
            </section>

            {/* Personalisation eligibility (migration 000172).
                When on, designers can tick the "Add personalisation"
                box on a membership-card version using this material.
                Hidden entirely for business cards regardless of this
                flag. Edit personalisation prices on the Settings
                page (Personalisation pricing section). */}
            <section>
              <div className="flex items-start justify-between gap-3">
                <label className="text-sm font-medium text-ink-soft">
                  Supports personalisation
                </label>
                {supportsPersonalisationInFlight && (
                  <span className="text-xs text-ink-dim">Saving…</span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveSupportsPersonalisation(!supportsPersonalisation)}
                  disabled={supportsPersonalisationInFlight}
                  role="switch"
                  aria-checked={supportsPersonalisation}
                  className={[
                    'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
                    supportsPersonalisation ? 'bg-ink' : 'bg-line',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
                      supportsPersonalisation ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
                    ].join(' ')}
                  />
                </button>
                <span className="text-sm text-ink-soft">
                  {supportsPersonalisation
                    ? 'Designers can add personalisation to membership cards on this material.'
                    : 'Personalisation is hidden for this material.'}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-ink-mute">
                Personalisation prices live one rate, one floor per currency, edited from the Settings page.
              </p>
              {supportsPersonalisationError && (
                <p className="mt-1.5 text-xs text-out">{supportsPersonalisationError}</p>
              )}
            </section>

            {/* Icon */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Icon</label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const f = e.dataTransfer.files?.[0]
                  if (f) void handleFile(f)
                }}
                className={[
                  'flex min-h-[10rem] items-center justify-center gap-6 rounded-2xl border-2 border-dashed p-4 transition-colors',
                  dragOver ? 'border-ink bg-canvas' : 'border-line',
                ].join(' ')}
              >
                {currentIconUrl ? (
                  <img src={currentIconUrl} alt="Icon preview" className="max-h-32 max-w-[12rem] object-contain" />
                ) : (
                  <p className="text-sm text-ink-dim">No icon set</p>
                )}
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void handleFile(f)
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={saving}
                    className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
                  >
                    {currentIconUrl ? 'Replace icon' : 'Upload icon'}
                  </button>
                  {currentIconUrl && (
                    <button
                      onClick={handleRemoveIcon}
                      disabled={saving}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium text-out ring-1 ring-out hover:bg-out-soft disabled:opacity-50"
                    >
                      Remove icon
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-ink-mute">
                PNG, JPG or SVG, up to 2 MB. Square or roughly square, at least 480px wide works best. Transparent backgrounds render cleanly.
              </p>
            </section>

            {/* Publish status */}
            <section className={isArchived ? 'opacity-60' : ''}>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Publish status</label>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-canvas px-4 py-3 ring-1 ring-line">
                <div className="flex items-center gap-3">
                  {isPublished ? (
                    <span className="inline-block rounded-full bg-in-stock-soft px-2.5 py-0.5 text-xs font-semibold text-in-stock">Published</span>
                  ) : (
                    <span className="inline-block rounded-full bg-low-soft px-2.5 py-0.5 text-xs font-semibold text-low">Unpublished</span>
                  )}
                  <p className="text-sm text-ink-soft">
                    {isPublished
                      ? 'This material is live.'
                      : 'This material is not visible to designers yet.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onPublishClick}
                  disabled={publishInFlight || saving || isArchived}
                  className={[
                    'rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50',
                    isPublished
                      ? 'text-ink-soft ring-1 ring-line hover:bg-surface'
                      : 'bg-ink text-on-ink hover:opacity-90',
                  ].join(' ')}
                >
                  {publishInFlight
                    ? 'Saving…'
                    : isPublished ? 'Unpublish' : 'Publish'}
                </button>
              </div>
              {isArchived && (
                <p className="mt-1.5 text-xs text-ink-mute">Unarchive this material before publishing.</p>
              )}
              {publishError && (
                <p className="mt-1.5 text-xs text-out">{publishError}</p>
              )}
            </section>

            {/* Archive (Phase 4). Hard-stop destructive action with a
                soft-confirm before commit. Unarchive is a straight
                toggle — the admin still has to re-publish explicitly. */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Archive</label>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-canvas px-4 py-3 ring-1 ring-line">
                <div className="flex items-center gap-3">
                  {isArchived ? (
                    <span className="inline-block rounded-full bg-line px-2.5 py-0.5 text-xs font-semibold text-ink-soft">Archived</span>
                  ) : (
                    <span className="inline-block rounded-full bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-soft">Active</span>
                  )}
                  <p className="text-sm text-ink-soft">
                    {isArchived
                      ? 'Hidden from the designer dropdown. Unarchive to restore.'
                      : 'Use archive for materials you no longer sell.'}
                  </p>
                </div>
                {isArchived ? (
                  <button
                    type="button"
                    onClick={() => void applyUnarchive()}
                    disabled={archiveInFlight || saving}
                    className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
                  >
                    {archiveInFlight ? 'Saving…' : 'Unarchive'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={requestArchive}
                    disabled={archiveInFlight || saving}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-low ring-1 ring-low hover:bg-low-soft disabled:opacity-50"
                  >
                    Archive
                  </button>
                )}
              </div>
              {unarchiveNotice && (
                <p className="mt-1.5 text-xs text-in-stock">
                  {material.display_name} unarchived. Republish from the Publish section when ready.
                </p>
              )}
              {archiveError && (
                <p className="mt-1.5 text-xs text-out">{archiveError}</p>
              )}
            </section>

            {error && (
              <p className="rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{error}</p>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end border-t border-line-soft px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90"
            >
              Done
            </button>
          </div>
      </Modal>

      {/* Soft-confirm modal for publishing a material with nothing in it. */}
      <Modal
        open={publishConfirm}
        onClose={() => setPublishConfirm(false)}
        preventClose={publishInFlight}
        ariaLabel="Publish anyway confirmation"
        panelClassName="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-line"
      >
        <h4 className="text-base font-semibold text-ink">Publish anyway?</h4>
        <p className="mt-2 text-sm text-ink-soft">
          This material has no variants or prices. Designers will see it but won't be able to add versions with it. Publish anyway?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPublishConfirm(false)}
            disabled={publishInFlight}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void applyPublishChange(true)}
            disabled={publishInFlight}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
          >
            {publishInFlight ? 'Publishing…' : 'Publish anyway'}
          </button>
        </div>
      </Modal>

      {/* Soft-confirm modal for archive. Amber-toned rather than
          outright red — archive is reversible, but still a deliberate
          action worth explicit confirmation. */}
      <Modal
        open={archiveConfirm}
        onClose={() => setArchiveConfirm(false)}
        preventClose={archiveInFlight}
        ariaLabel="Archive material confirmation"
        panelClassName="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-line"
      >
        <h4 className="text-base font-semibold text-ink">Archive {material.display_name}?</h4>
        <p className="mt-2 text-sm text-ink-soft">
          This hides it from the designer dropdown and unpublishes it. You can unarchive later from the Archived section of Settings.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setArchiveConfirm(false)}
            disabled={archiveInFlight}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void applyArchive()}
            disabled={archiveInFlight}
            className="rounded-lg bg-low px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
          >
            {archiveInFlight ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </Modal>
    </>
  )
}
