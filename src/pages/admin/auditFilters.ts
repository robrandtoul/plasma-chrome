// Filter definitions shared by the activity page, its filter bar, the
// URL-state sync, and the CSV export call. Keeping them in one place
// stops the label mapping from drifting between the dropdown and the
// diff viewer.

export interface AuditFilters {
  /** Empty = all actors. 'null' = customer rows. Otherwise = actor_id. */
  actor: string
  /** Empty = all actions. */
  action: string
  /** Empty = all types. */
  targetType: string
  /** Empty = all time. */
  datePreset: DatePreset
  /** Only used when datePreset === 'custom'. ISO date yyyy-mm-dd. */
  from: string
  to: string
  /** Case-insensitive substring search across actor/target labels + email. */
  q: string
}

export type DatePreset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'

export const EMPTY_FILTERS: AuditFilters = {
  actor: '',
  action: '',
  targetType: '',
  datePreset: 'all',
  from: '',
  to: '',
  q: '',
}

export function isAnyFilterActive(f: AuditFilters): boolean {
  return f.actor !== '' || f.action !== '' || f.targetType !== '' || f.datePreset !== 'all' || f.q !== ''
}

/** Turn a preset into concrete from/to ISO strings. Custom returns what's
 *  in the filter object unchanged. */
export function resolveDateRange(f: AuditFilters): { from: string; to: string } {
  const now = new Date()
  const startOfDay = (d: Date) => {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
  }
  const endOfDay = (d: Date) => {
    const x = new Date(d)
    x.setHours(23, 59, 59, 999)
    return x
  }
  const iso = (d: Date) => d.toISOString()
  if (f.datePreset === 'today') {
    return { from: iso(startOfDay(now)), to: iso(endOfDay(now)) }
  }
  if (f.datePreset === 'yesterday') {
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    return { from: iso(startOfDay(y)), to: iso(endOfDay(y)) }
  }
  if (f.datePreset === '7d') {
    const start = new Date(now)
    start.setDate(start.getDate() - 7)
    return { from: iso(startOfDay(start)), to: iso(endOfDay(now)) }
  }
  if (f.datePreset === '30d') {
    const start = new Date(now)
    start.setDate(start.getDate() - 30)
    return { from: iso(startOfDay(start)), to: iso(endOfDay(now)) }
  }
  if (f.datePreset === 'custom') {
    const from = f.from ? iso(startOfDay(new Date(f.from))) : ''
    const to = f.to ? iso(endOfDay(new Date(f.to))) : ''
    return { from, to }
  }
  return { from: '', to: '' }
}

// ── URL state sync ──────────────────────────────────────────────────────────

export function filtersFromSearchParams(params: URLSearchParams): AuditFilters {
  return {
    actor: params.get('actor') ?? '',
    action: params.get('action') ?? '',
    targetType: params.get('target_type') ?? '',
    datePreset: ((params.get('date') as DatePreset) || 'all'),
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    q: params.get('q') ?? '',
  }
}

export function filtersToSearchParams(f: AuditFilters): URLSearchParams {
  const out = new URLSearchParams()
  if (f.actor) out.set('actor', f.actor)
  if (f.action) out.set('action', f.action)
  if (f.targetType) out.set('target_type', f.targetType)
  if (f.datePreset !== 'all') out.set('date', f.datePreset)
  if (f.from) out.set('from', f.from)
  if (f.to) out.set('to', f.to)
  if (f.q) out.set('q', f.q)
  return out
}

// ── Action & target type taxonomies ──────────────────────────────────────────

export interface ActionDef { code: string; label: string }

export const ACTION_GROUPS: { name: string; actions: ActionDef[] }[] = [
  { name: 'User management', actions: [
    { code: 'user.created',     label: 'User created' },
    { code: 'user.deactivated', label: 'User deactivated' },
    { code: 'user.reactivated', label: 'User reactivated' },
    { code: 'user.role_changed', label: 'User role changed' },
  ]},
  { name: 'Materials', actions: [
    { code: 'material_created',              label: 'Material created' },
    { code: 'material_published',            label: 'Material published' },
    { code: 'material_unpublished',          label: 'Material unpublished' },
    { code: 'material_archived',             label: 'Material archived' },
    { code: 'material_unarchived',           label: 'Material unarchived' },
    { code: 'material.name_updated',         label: 'Material renamed' },
    { code: 'material.category_updated',     label: 'Material category changed' },
    { code: 'material.description_updated',  label: 'Material description updated' },
    { code: 'material.icon_uploaded',        label: 'Material icon uploaded' },
    { code: 'material.icon_removed',         label: 'Material icon removed' },
    { code: 'variant_created',               label: 'Variant created' },
    { code: 'variant.display_name_updated',  label: 'Variant renamed' },
    { code: 'variant_activated',             label: 'Variant activated' },
    { code: 'variant_deactivated',           label: 'Variant deactivated' },
  ]},
  { name: 'Pricing', actions: [
    { code: 'price_tier_created',         label: 'Price tier created' },
    { code: 'price_tier.updated',         label: 'Price tier updated' },
    { code: 'price_tier_deleted',         label: 'Price tier deleted' },
    { code: 'material_surcharge.updated', label: 'Material surcharge updated' },
    { code: 'addon_price.updated',        label: 'Add-on price updated' },
    { code: 'addon_prices.seeded',        label: 'Add-on prices seeded' },
    { code: 'pricing.imported',           label: 'Pricing imported' },
  ]},
  { name: 'Customers', actions: [
    { code: 'company.created', label: 'Company created' },
    { code: 'company.updated', label: 'Company updated' },
    { code: 'company.deleted', label: 'Company deleted' },
    { code: 'contact.created', label: 'Contact created' },
    { code: 'contact.updated', label: 'Contact updated' },
    { code: 'contact.deleted', label: 'Contact deleted' },
  ]},
  { name: 'Proofs', actions: [
    { code: 'proof.created',           label: 'Proof created' },
    { code: 'version.added',           label: 'Version added' },
    { code: 'proof.approved',          label: 'Proof approved' },
    { code: 'proof.abandoned',         label: 'Proof abandoned' },
    { code: 'proof.deleted',           label: 'Proof deleted' },
    { code: 'proof.helpscout_linked',  label: 'Help Scout linked' },
  ]},
  { name: 'Customer-facing', actions: [
    { code: 'version.viewed',                label: 'Proof viewed' },
    { code: 'version.approved_by_customer',  label: 'Approved by customer' },
  ]},
]

export const TARGET_TYPE_OPTIONS: ActionDef[] = [
  { code: 'user',          label: 'User' },
  { code: 'proof',         label: 'Proof' },
  { code: 'version',       label: 'Version' },
  { code: 'price_tier',    label: 'Price tier' },
  { code: 'material',      label: 'Material surcharge' },
  { code: 'add_on_price',  label: 'Add-on price' },
  { code: 'add_on',        label: 'Add-on' },
  { code: 'company',       label: 'Company' },
  { code: 'contact',       label: 'Contact' },
  { code: 'pricing',       label: 'Pricing import' },
]

/** Flat lookup: action code → human label. Falls back to the raw code. */
export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a.code, a.label])),
)
