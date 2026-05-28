import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// ── Types ────────────────────────────────────────────────────────────────────

type VariantType = 'thickness' | 'ink_count' | 'finish' | 'default'

const VARIANT_TYPE_OPTIONS: { value: VariantType; label: string; help?: string }[] = [
  { value: 'thickness', label: 'Thickness' },
  { value: 'ink_count', label: 'Ink count' },
  { value: 'finish',    label: 'Finish' },
  { value: 'default',   label: 'None', help: 'Single variant. Typical for wood, acrylic, carbon fibre.' },
]

// Values mirror the CHECK constraint on materials.category installed
// in 000009_rebuild_pricing. Adding new categories would need a
// migration and is out of scope for the create-material flow.
type Category = 'metal' | 'plastic' | 'paper' | 'wood' | 'carbon_fibre' | 'acrylic'

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: 'metal',        label: 'Metal' },
  { value: 'plastic',      label: 'Plastic' },
  { value: 'paper',        label: 'Paper' },
  { value: 'wood',         label: 'Wood' },
  { value: 'carbon_fibre', label: 'Carbon fibre' },
  { value: 'acrylic',      label: 'Acrylic' },
]

// Turn a name into a URL-safe slug: lowercase, spaces to hyphens, strip
// anything outside [a-z0-9-], collapse repeats, trim leading/trailing
// hyphens. Same rule the backend check constraint enforces later.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminCreateMaterialPage() {
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [variantType, setVariantType] = useState<VariantType>('thickness')
  const [multiVariant, setMultiVariant] = useState(false)
  const [optionLabel, setOptionLabel] = useState('')
  const [requiresInkNames, setRequiresInkNames] = useState(false)
  const [sortOrder, setSortOrder] = useState<number>(0)
  const [surchargeGbp, setSurchargeGbp] = useState<string>('0')
  const [surchargeEur, setSurchargeEur] = useState<string>('0')
  const [surchargeUsd, setSurchargeUsd] = useState<string>('0')

  const [defaultSortOrderReady, setDefaultSortOrderReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Default sort_order to max(existing) + 10.
  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('materials')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
      const next = ((data?.[0]?.sort_order as number | undefined) ?? 0) + 10
      setSortOrder(next)
      setDefaultSortOrderReady(true)
    })()
  }, [])

  // Slug auto-populates from name on blur, but only until the admin has
  // touched the slug field explicitly.
  function onNameBlur() {
    if (!slugTouched && !slug) setSlug(slugify(name))
  }

  function onSlugChange(v: string) {
    setSlugTouched(true)
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    // ── Client-side validation ────────────────────────────────────────────
    const trimmedName = name.trim()
    if (!trimmedName) { setError('Name is required.'); return }
    if (trimmedName.length > 60) { setError('Name must be 60 characters or fewer.'); return }
    if (!category) { setError('Category is required.'); return }
    if (!CATEGORY_OPTIONS.some((o) => o.value === category)) {
      setError('Invalid category.')
      return
    }
    if (!slug) { setError('Slug is required.'); return }
    if (!/^[a-z0-9-]+$/.test(slug)) { setError('Slug can only contain lowercase letters, digits and hyphens.'); return }
    if (sortOrder < 0) { setError('Sort order must be zero or greater.'); return }

    const parsedGbp = parseFloat(surchargeGbp) || 0
    const parsedEur = parseFloat(surchargeEur) || 0
    const parsedUsd = parseFloat(surchargeUsd) || 0
    if (parsedGbp < 0 || parsedEur < 0 || parsedUsd < 0) {
      setError('Surcharges must be zero or greater.')
      return
    }

    // Soft correction: multi_variant only makes sense for materials
    // with multiple variants. Reject if the admin picks "None" + on.
    if (variantType === 'default' && multiVariant) {
      setError('Multi-variant is only meaningful for materials with multiple options. Leave it off for single-variant materials.')
      return
    }

    // Duplicate-slug pre-check. The DB unique index is the source of
    // truth; this just gives a friendlier error before we INSERT.
    const { data: dupes } = await supabase
      .from('materials')
      .select('id')
      .eq('code', slug)
      .limit(1)
    if (dupes && dupes.length > 0) {
      setError('A material with this slug already exists.')
      return
    }

    // ── Insert ─────────────────────────────────────────────────────────────
    setSubmitting(true)
    const insertRow = {
      code: slug,
      display_name: trimmedName,
      category,
      sort_order: sortOrder,
      is_active: true,
      is_published: false,
      variant_type: variantType,
      multi_variant: multiVariant,
      requires_ink_names: requiresInkNames,
      option_label: optionLabel.trim() || null,
      split_name_surcharge_gbp: parsedGbp,
      split_name_surcharge_eur: parsedEur,
      split_name_surcharge_usd: parsedUsd,
    }
    const { data: created, error: insertErr } = await supabase
      .from('materials')
      .insert(insertRow)
      .select('id, code, display_name, variant_type')
      .single()
    if (insertErr || !created) {
      setSubmitting(false)
      if (insertErr?.code === '23505') {
        setError('A material with this slug already exists.')
      } else {
        setError(`Failed to create material: ${insertErr?.message ?? 'unknown error'}`)
      }
      return
    }

    // Default-type materials need a variant to hang prices off. Create a
    // single placeholder with variant_type = 'default' and display_name
    // matching the material name.
    if (variantType === 'default') {
      const { error: variantErr } = await supabase
        .from('material_variants')
        .insert({
          material_id: created.id,
          code: 'default',
          display_name: trimmedName,
          variant_type: 'default',
          sort_order: 10,
          is_active: true,
        })
      if (variantErr) {
        setSubmitting(false)
        setError(`Material created, but the default variant could not be created: ${variantErr.message}. Open the pricing editor to fix manually.`)
        // Still navigate — the material exists and the admin can recover.
      }
    }

    // Audit entry. Captures every form field so the creation is fully
    // reconstructible from the activity log.
    void logAudit({
      action: 'material_created',
      targetType: 'material',
      targetId: created.id,
      targetLabel: created.display_name,
      metadata: { ...insertRow, auto_variant_created: variantType === 'default' },
    })

    // Redirect to the existing pricing editor for this material.
    navigate(`/admin/pricing/materials/${created.code}?created=1`)
  }

  return (
    <div>
      <div className="mb-6">
        <Link to="/admin/settings" className="text-xs text-ink-dim hover:text-ink-soft">← Back to settings</Link>
        <h2 className="mt-2 text-xl font-bold text-ink">Add material</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Creates a new material in an unpublished state. You can add variants and prices before making it visible to designers.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        {/* Name */}
        <Field
          label="Name"
          required
          help="What designers and customers see, e.g. Brushed Aluminium."
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={onNameBlur}
            maxLength={60}
            className={inputClass}
            placeholder="e.g. Brushed Aluminium"
          />
        </Field>

        {/* Category */}
        <Field
          label="Category"
          required
          help="Groups this material in the designer's dropdown."
        >
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className={'select-styled ' + inputClass}
          >
            <option value="">Select a category</option>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>

        {/* Slug */}
        <Field
          label="Slug"
          required
          help="Used internally. Cannot be changed after creation."
        >
          <input
            type="text"
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            className={inputClass + ' font-mono'}
            placeholder="brushed-aluminium"
            pattern="[a-z0-9-]+"
          />
        </Field>

        {/* Variant type */}
        <Field label="Variant type" required>
          <div className="flex flex-wrap gap-2">
            {VARIANT_TYPE_OPTIONS.map((o) => {
              const active = variantType === o.value
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setVariantType(o.value)}
                  className={[
                    'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-ink text-on-ink'
                      : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                  ].join(' ')}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          {variantType === 'default' && (
            <p className="mt-1.5 text-xs text-ink-mute">
              A single placeholder variant will be created so you can attach prices. You can rename or replace it in the pricing editor.
            </p>
          )}
        </Field>

        {/* Multi-variant */}
        <Field
          label="Multi-variant"
          help="When on, designers can pick multiple variant options per proof version. Typically used for thickness materials."
        >
          <Toggle value={multiVariant} onChange={setMultiVariant} />
        </Field>

        {/* Option label */}
        <Field
          label="Option label"
          help="What to call the secondary options dimension, e.g. Finish, Species, Cutting. Leave blank if the material has no options."
        >
          <input
            type="text"
            value={optionLabel}
            onChange={(e) => setOptionLabel(e.target.value)}
            className={inputClass}
            placeholder="e.g. Finish"
          />
        </Field>

        {/* Requires ink names */}
        <Field
          label="Requires ink names"
          help="Show ink name fields on the designer's Add version form. Turn on for letterpress-style materials."
        >
          <Toggle value={requiresInkNames} onChange={setRequiresInkNames} />
        </Field>

        {/* Sort order */}
        <Field
          label="Sort order"
          help="Position in the designer's dropdown. Lower numbers appear first."
        >
          <input
            type="number"
            min={0}
            value={defaultSortOrderReady ? sortOrder : ''}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className={inputClass + ' w-32'}
          />
        </Field>

        {/* Surcharges */}
        <Field
          label="Split-name tooling surcharges"
          help="Charged per extra name beyond the first. Set to zero if this material does not offer split names."
        >
          <div className="grid grid-cols-3 gap-3">
            <SurchargeInput label="GBP" value={surchargeGbp} onChange={setSurchargeGbp} />
            <SurchargeInput label="EUR" value={surchargeEur} onChange={setSurchargeEur} />
            <SurchargeInput label="USD" value={surchargeUsd} onChange={setSurchargeUsd} />
          </div>
        </Field>

        {error && (
          <p className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Link
            to="/admin/settings"
            className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create material'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function Field({ label, required, help, children }: {
  label: string
  required?: boolean
  help?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-ink-soft">
        {label} {required && <span className="text-out">*</span>}
      </label>
      {children}
      {help && <p className="mt-1.5 text-xs text-ink-mute">{help}</p>}
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
        value ? 'bg-ink' : 'bg-line',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-x-0.5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
          value ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

function SurchargeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-dim">{label}</label>
      <input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass + ' tabular-nums'}
      />
    </div>
  )
}

const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
