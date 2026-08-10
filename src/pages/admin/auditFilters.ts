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
    { code: 'material.outsourcing_updated',              label: 'Material outsourcing updated' },
    { code: 'material_variant.xero_item_codes_updated',  label: 'Variant Xero item codes updated' },
    { code: 'material_option.created',                   label: 'Material option created' },
    { code: 'material_option.updated',                   label: 'Material option updated' },
    { code: 'material_option.deleted',                   label: 'Material option deleted' },
    { code: 'material.finish_photo_uploaded',            label: 'Finish photo uploaded' },
    { code: 'material.finish_photo_removed',             label: 'Finish photo removed' },
    { code: 'material.finish_description_updated',       label: 'Finish description updated' },
    { code: 'material.stock_material_mapping_updated',   label: 'Stock Control material mapping updated' },
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
    { code: 'prototype_prices.updated',                    label: 'Prototype prices updated' },
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
    { code: 'proof.duplicated',                label: 'Project duplicated' },
    { code: 'proof.reorder_raised',            label: 'Reorder raised' },
    { code: 'version.preview_confirmed',       label: 'Proof preview confirmed' },
    { code: 'version.preview_edit_return',     label: 'Returned to edit from preview' },
  ]},
  { name: 'Bundles', actions: [
    { code: 'proof_set.created',      label: 'Bundle created' },
    { code: 'proof_set.card_added',   label: 'Card added to bundle' },
    { code: 'proof_set.card_removed', label: 'Card removed from bundle' },
    { code: 'proof_set.sent',         label: 'Bundle sent to customer' },
    { code: 'proof_set.deleted',      label: 'Bundle deleted' },
  ]},
  { name: 'Reorder desk', actions: [
    { code: 'reorder_desk.started',          label: 'Past customer started' },
    { code: 'reorder_desk.skipped',          label: 'Past customer skipped' },
    { code: 'reorder_desk.marked_contacted', label: 'Outreach sent by hand' },
    { code: 'reorder_desk.follow_up_sent',   label: 'Re-engagement follow-up sent' },
    { code: 'reorder_desk.closed_quiet',     label: 'Outreach closed — no response' },
    { code: 'reorder_desk.restored',         label: 'Past customer put back on the register' },
  ]},
  { name: 'Orders', actions: [
    { code: 'order.created',                  label: 'Order created' },
    { code: 'order.shipping_updated',         label: 'Delivery details updated' },
    { code: 'order.placed',                   label: 'Order placed for production' },
    { code: 'order.review_exited',            label: 'Left order review without placing' },
    { code: 'order.place_sent_not_recorded',  label: 'Order placed but not recorded' },
    { code: 'order.link_reactivated',         label: 'Pay link reactivated' },
    { code: 'order.invoice_retried',          label: 'Invoice retried' },
    { code: 'order.invoice_retry_failed',     label: 'Invoice retry failed' },
    { code: 'order.auto_reminder_sent',       label: 'Order reminder sent' },
  ]},
  { name: 'Flagged & reprints', actions: [
    { code: 'watch.flagged',          label: 'Project flagged' },
    { code: 'watch.status_changed',   label: 'Flag status changed' },
    { code: 'watch.update_added',     label: 'Flag update added' },
    { code: 'watch.removed',          label: 'Flag removed' },
    { code: 'watch.reprint_created',  label: 'Reprint created' },
    { code: 'watch.reprint_reopen',   label: 'Reprint reopened project' },
  ]},
  { name: 'Customer-facing', actions: [
    { code: 'version.viewed',                label: 'Proof viewed' },
    { code: 'version.approved_by_customer',  label: 'Approved by customer' },
    { code: 'template.body_updated',         label: 'Reply template body updated' },
    { code: 'template.reset_to_default',     label: 'Reply template reset to default' },
    { code: 'reply_template.updated',        label: 'Reply template updated' },
  ]},
  { name: 'AI drafts', actions: [
    { code: 'ai_draft_house_rule.created', label: 'AI draft house rule added' },
    { code: 'ai_draft_house_rule.updated', label: 'AI draft house rule updated' },
    { code: 'ai_draft_exemplar.created',   label: 'AI draft exemplar added' },
    { code: 'ai_draft_exemplar.updated',   label: 'AI draft exemplar updated' },
    // Emitted by the edge functions, not from src/, so the taxonomy test below
    // cannot discover them — they have to be listed by hand or they show up in
    // Activity as raw codes and never appear in the filter. The unreadable
    // -version one matters most: migration 000351's whole design rests on an
    // admin being able to FIND it here when the briefing stamp stops working.
    { code: 'ai_draft.briefing_fallback',          label: 'AI draft fell back to the built-in briefing' },
    { code: 'ai_draft.briefing_version_unreadable', label: 'AI draft could not read the briefing version' },
    { code: 'ai_draft.miner_run',                  label: 'AI draft suggestion miner ran' },
  ]},
  { name: 'Team', actions: [
    { code: 'announcement.created',     label: 'Announcement posted' },
    { code: 'announcement.removed',     label: 'Announcement removed' },
    { code: 'feedback.created',         label: 'Feedback posted' },
    { code: 'feedback.status_changed',  label: 'Feedback status changed' },
    { code: 'feedback.deleted',         label: 'Feedback deleted' },
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
    { code: 'setting.auto_nudges_enabled_updated',              label: 'Auto follow-up reminders toggle changed' },
    { code: 'setting.ai_drafts_mode_updated',                   label: 'AI drafts mode changed' },
    { code: 'setting.ai_drafts_triage_model_updated',           label: 'AI drafts triage model changed' },
    { code: 'setting.ai_drafts_model_updated',                  label: 'AI drafts draft model changed' },
    { code: 'setting.ai_draft_miner_enabled_updated',           label: 'AI drafts suggestion miner switched on or off' },
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
  { code: 'order',         label: 'Order' },
  { code: 'reply_template',      label: 'Reply template' },
  { code: 'material_option',     label: 'Material option' },
  { code: 'ai_draft_house_rule', label: 'AI draft house rule' },
  { code: 'ai_draft_exemplar',   label: 'AI draft exemplar' },
  { code: 'ai_draft_proposal',   label: 'AI draft proposal' },
  { code: 'order_group',   label: 'Combined payment' },
  { code: 'proof_set',     label: 'Bundle' },
  { code: 'reorder_prospect', label: 'Past customer (Reorder desk)' },
  { code: 'watch_item',    label: 'Flagged project' },
  { code: 'feedback',      label: 'Feedback item' },
  { code: 'announcement',  label: 'Announcement' },
  { code: 'prototype_prices', label: 'Prototype prices' },
  // Legacy: the preview gate emitted 'proof_version' where every other version
  // site emits 'version'. The emitter is now aligned, but rows written before
  // that fix keep the old value, so the option stays for them to be reachable.
  { code: 'proof_version', label: 'Proof version (legacy)' },
]

/** Flat lookup: action code → human label. Falls back to the raw code. */
export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a.code, a.label])),
)
