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
    { code: 'user.created',              label: 'User created' },
    { code: 'user.deactivated',          label: 'User deactivated' },
    { code: 'user.reactivated',          label: 'User reactivated' },
    { code: 'user.role_changed',         label: 'User role changed' },
    { code: 'profile.updated',           label: 'Profile updated' },
    { code: 'profile.avatar_uploaded',   label: 'Profile avatar uploaded' },
    { code: 'profile.avatar_removed',    label: 'Profile avatar removed' },
    { code: 'user.helpscout_user_id_set',     label: 'Help Scout user ID set' },
    { code: 'user.helpscout_user_id_cleared', label: 'Help Scout user ID cleared' },
    { code: 'user.password_reset_email_sent', label: 'Password reset email sent' },
    { code: 'user.password_set_directly',     label: 'Password set directly' },
  ]},
  { name: 'Materials', actions: [
    { code: 'material_created',                          label: 'Material created' },
    { code: 'material_published',                        label: 'Material published' },
    { code: 'material_unpublished',                      label: 'Material unpublished' },
    { code: 'material_archived',                         label: 'Material archived' },
    { code: 'material_unarchived',                       label: 'Material unarchived' },
    { code: 'material.name_updated',                     label: 'Material renamed' },
    { code: 'material.category_updated',                 label: 'Material category changed' },
    { code: 'material.description_updated',              label: 'Material description updated' },
    { code: 'material.icon_uploaded',                    label: 'Material icon uploaded' },
    { code: 'material.icon_removed',                     label: 'Material icon removed' },
    { code: 'material.display_quantities_updated',       label: 'Material display quantities updated' },
    { code: 'material.quote_min_quantity_updated',       label: 'Material quote minimum quantity updated' },
    { code: 'material.quote_max_quantity_updated',       label: 'Material quote maximum quantity updated' },
    { code: 'material.supports_personalisation_updated', label: 'Material personalisation support updated' },
    { code: 'material.key_features_updated',             label: 'Material key features updated' },
    { code: 'material.lead_times_updated',               label: 'Material lead times updated' },
    { code: 'variant_created',                           label: 'Variant created' },
    { code: 'variant.display_name_updated',              label: 'Variant renamed' },
    { code: 'variant_activated',                         label: 'Variant activated' },
    { code: 'variant_deactivated',                       label: 'Variant deactivated' },
    { code: 'material_variant.weights_updated',          label: 'Variant weights updated' },
    { code: 'core_colour_created',                       label: 'Core colour created' },
    { code: 'core_colour_updated',                       label: 'Core colour updated' },
    { code: 'core_colour_deactivated',                   label: 'Core colour deactivated' },
    { code: 'core_colour_reactivated',                   label: 'Core colour reactivated' },
  ]},
  { name: 'Pricing', actions: [
    { code: 'price_tier_created',                          label: 'Price tier created' },
    { code: 'price_tier.updated',                          label: 'Price tier updated' },
    { code: 'price_tier_deleted',                          label: 'Price tier deleted' },
    { code: 'material_surcharge.updated',                  label: 'Material surcharge updated' },
    { code: 'option_surcharges.metal_finish.tier_created', label: 'Metal finish surcharge tier created' },
    { code: 'option_surcharges.metal_finish.seeded',       label: 'Metal finish surcharges seeded' },
    { code: 'option_surcharge.metal_finish.updated',       label: 'Metal finish surcharge updated' },
    { code: 'option_surcharge.metal_finish.deleted',       label: 'Metal finish surcharge deleted' },
    { code: 'addon_price.updated',                         label: 'Add-on price updated' },
    { code: 'addon_price.deleted',                         label: 'Add-on price deleted' },
    { code: 'addon_prices.seeded',                         label: 'Add-on prices seeded' },
    { code: 'addon_prices.tier_created',                   label: 'Add-on price tier created' },
    { code: 'pricing.imported',                            label: 'Pricing imported' },
  ]},
  { name: 'Customers', actions: [
    { code: 'company.created', label: 'Company created' },
    { code: 'company.updated', label: 'Company updated' },
    { code: 'company.deleted', label: 'Company deleted' },
    { code: 'contact.created', label: 'Contact created' },
    { code: 'contact.updated', label: 'Contact updated' },
    { code: 'contact.deleted', label: 'Contact deleted' },
  ]},
  { name: 'Projects', actions: [
    { code: 'proof.created',                   label: 'Project created' },
    { code: 'version.added',                   label: 'Proof version added' },
    { code: 'proof.approved',                  label: 'Project approved' },
    { code: 'proof.abandoned',                 label: 'Project abandoned' },
    { code: 'proof.reopened',                  label: 'Project reopened' },
    { code: 'proof.deleted',                   label: 'Project deleted' },
    { code: 'proof.helpscout_link_set',        label: 'Help Scout link set' },
    { code: 'proof.helpscout_link_changed',    label: 'Help Scout link changed' },
    { code: 'proof.helpscout_override_set',    label: 'Help Scout override set' },
    { code: 'proof.snoozed',                   label: 'Project snoozed' },
    { code: 'proof.unsnoozed',                 label: 'Project unsnoozed' },
    { code: 'proof.reply_sent',                label: 'Reply sent to customer' },
    { code: 'proof.internal_notes_updated',    label: 'Internal notes updated' },
  ]},
  { name: 'Customer-facing', actions: [
    { code: 'version.viewed',                label: 'Proof viewed' },
    { code: 'version.approved_by_customer',  label: 'Approved by customer' },
    { code: 'template.body_updated',         label: 'Reply template body updated' },
    { code: 'template.reset_to_default',     label: 'Reply template reset to default' },
  ]},
  { name: 'Settings', actions: [
    { code: 'setting.disclaimer_updated',                       label: 'Disclaimer copy updated' },
    { code: 'setting.company_name_updated',                     label: 'Company name updated' },
    { code: 'setting.reply_email_updated',                      label: 'Reply email updated' },
    { code: 'setting.default_pricing_display_updated',          label: 'Default pricing display updated' },
    { code: 'setting.default_currency_updated',                 label: 'Default currency updated' },
    { code: 'setting.vat_rate_gbp_updated',                     label: 'GBP VAT rate updated' },
    { code: 'setting.approvals_enabled_updated',                label: 'Approvals toggle changed' },
    { code: 'setting.approve_confirmation_copy_updated',        label: 'Approve confirmation copy updated' },
    { code: 'setting.request_changes_confirmation_copy_updated', label: 'Request-changes confirmation copy updated' },
    { code: 'setting.about_proof_copy_updated',                 label: 'About-this-proof note updated' },
    { code: 'setting.qr_panel_intro_copy_updated',              label: 'QR panel review-instructions copy updated' },
    { code: 'setting.qr_panel_vcard_copy_updated',              label: 'QR panel Plasma vCard note updated' },
    { code: 'setting.replies_enabled_updated',                  label: 'Reply templates toggle changed' },
    { code: 'setting.team_pin_added',                           label: 'Team pin added' },
    { code: 'setting.team_pin_removed',                         label: 'Team pin removed' },
    { code: 'setting.needs_attention_rules_updated',            label: 'Needs-attention rules updated' },
    { code: 'setting.personalisation_per_card_rate_updated',    label: 'Personalisation per-card rate updated' },
    { code: 'setting.personalisation_min_charge_updated',       label: 'Personalisation minimum charge updated' },
    { code: 'setting.fedex_box_weight_grams_updated',           label: 'FedEx box weight updated' },
    { code: 'setting.fedex_intl_adjust_percent_updated',        label: 'FedEx international adjustment updated' },
    { code: 'setting.domestic_uk_mainland_rate_gbp_updated',    label: 'UK mainland shipping rate updated' },
    { code: 'setting.domestic_uk_ni_rate_gbp_updated',          label: 'Northern Ireland shipping rate updated' },
    { code: 'setting.login_copy_updated',                       label: 'Login page copy updated' },
    { code: 'setting.metal_thickness_notes_updated',            label: 'Metal thickness notes updated' },
  ]},
]

export const TARGET_TYPE_OPTIONS: ActionDef[] = [
  { code: 'user',          label: 'User' },
  { code: 'proof',         label: 'Project' },
  { code: 'version',       label: 'Proof version' },
  { code: 'price_tier',    label: 'Price tier' },
  { code: 'material',      label: 'Material surcharge' },
  { code: 'add_on_price',  label: 'Add-on price' },
  { code: 'add_on',        label: 'Add-on' },
  { code: 'material_variant',        label: 'Material variant' },
  { code: 'letterpress_core_colour', label: 'Letterpress core colour' },
  { code: 'company',       label: 'Company' },
  { code: 'contact',       label: 'Contact' },
  { code: 'pricing',       label: 'Pricing import' },
  { code: 'setting',       label: 'Setting' },
  { code: 'template',      label: 'Reply template' },
]

/** Flat lookup: action code → human label. Falls back to the raw code. */
export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a.code, a.label])),
)
