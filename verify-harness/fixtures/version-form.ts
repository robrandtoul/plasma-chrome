// Fixtures for the designer VERSION FORMS (/proofs/:id/versions/new and
// /proofs/:id/versions/:versionId/edit) in the verify harness.
//
// Owned by the version-form e2e work — mock-supabase.ts delegates to these
// hooks FIRST and falls through to its own fixtures when they return null.
// Only claim requests that belong to this area's fixture ids (prefix `vf-`),
// return null for everything else, and never edit mock-supabase.ts /
// entry.tsx from the same change that edits this file.
//
// The page's complete data surface, derived from NewVersionPage.tsx:
//
//   on mount  proofs            — header (contact + company + HS id), .eq(id)
//             proofs            — currency-suggestion contact read, .eq(id)
//             proofs            — sibling-project currency read,
//                                 .eq(contacts.company_id) / .eq(contact_id)
//             materials         — active+published catalogue (no fixture id)
//             proof_versions    — the is_current version to inherit from
//             proof_version_images / proof_name_approvals — carry-forward
//             proof_round_variants / proof_events — variant-round sources only
//             proof_layouts     — set_collection sources only
//             settings          — default_pricing_display + default_currency
//             letterpress_core_colours — colour catalogue (no fixture id)
//   reactive  material_variants / material_options — per selected material
//             price_tiers       — per selected variants + currency
//             personalisation_pricing — per currency (no fixture id)
//   invoke    fetch-helpscout-conversation-context — currency suggestion
//
// Tables that carry no vf- id in their filters (materials, settings,
// letterpress_core_colours, personalisation_pricing) are claimed only while
// the harness is actually mounting /proofs/vf-… — the same URL-scoping
// precedent customer-proof.ts uses for public_settings — and additionally by
// their version-form-specific select strings, so other pages keep whatever
// their own modules or the generic fallback provide.
//
// Fixture states:
//   vf-blank  in-progress proof with NO versions — the v1 creation form.
//             Wizard starts unanswered, form fully expanded, settings
//             defaults fill pricing display (standard) + currency (GBP).
//   vf-open   in-progress proof whose current v1 is a two-recipient
//             Recipients version (Asha Rao + Ben Cole, one per-name front
//             image each) on the steel material. Loads as a collapsed
//             continuation with both images carried and Save immediately
//             valid — the state the selection-loss guard exists to protect.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HookQueryState } from './customer-proof'

const vf = (v: unknown): v is string => typeof v === 'string' && v.startsWith('vf-')

// Mirrors entry.tsx's ?path= / #hash resolution, scoped to this area's pages.
function onVersionFormPage(): boolean {
  if (typeof window === 'undefined') return false
  const path =
    new URLSearchParams(window.location.search).get('path') ??
    (window.location.hash ? window.location.hash.replace(/^#/, '') : '')
  return path.startsWith('/proofs/vf-')
}

// ── Catalogue ────────────────────────────────────────────────────────────────
// Steel: multi-variant (three thicknesses auto-select on pick) and
// supports_personalisation, so the Set branch's material-gated question has a
// material that reveals it. No material_options rows — keeps the image grid
// single-tab so carry-forward slots are deterministic. Wood: single default
// variant, no personalisation — the contrast material for the gate test.
const MATERIALS = [
  {
    id: 'vf-mat-steel',
    code: 'metal_steel',
    display_name: 'Stainless Steel',
    requires_ink_names: false,
    option_label: 'Finish',
    display_quantities: null,
    multi_variant: true,
    archived_at: null,
    supports_personalisation: true,
  },
  {
    id: 'vf-mat-wood',
    code: 'wood',
    display_name: 'Wood',
    requires_ink_names: false,
    option_label: 'Species',
    display_quantities: null,
    multi_variant: false,
    archived_at: null,
    supports_personalisation: false,
  },
]

const MATERIAL_VARIANTS = [
  { id: 'vf-var-300', material_id: 'vf-mat-steel', display_name: '300 micron', variant_type: 'thickness', sort_order: 1, ink_count: null },
  { id: 'vf-var-500', material_id: 'vf-mat-steel', display_name: '500 micron', variant_type: 'thickness', sort_order: 2, ink_count: null },
  { id: 'vf-var-800', material_id: 'vf-mat-steel', display_name: '800 micron', variant_type: 'thickness', sort_order: 3, ink_count: null },
  { id: 'vf-var-wood', material_id: 'vf-mat-wood', display_name: 'Standard', variant_type: 'default', sort_order: 1, ink_count: null },
]

// Every variant priced in every currency the form can pick, so the
// auto-custom-quote detection ("a selected variant loaded with zero tiers")
// never fires and pricing display stays at the designer's choice.
const PRICE_TIERS = MATERIAL_VARIANTS.flatMap((v, vi) =>
  (['GBP', 'EUR', 'USD'] as const).flatMap((currency) =>
    [100, 250, 500].map((quantity, qi) => ({
      material_variant_id: v.id,
      currency,
      quantity,
      total_price: 149 + vi * 40 + qi * 110,
    })),
  ),
)

// ── The two fixture proofs ───────────────────────────────────────────────────

function header(contactId: string, companyId: string, fullName: string, company: string) {
  return {
    helpscout_conversation_id: null,
    contact_id: contactId,
    contacts: {
      full_name: fullName,
      // .example addresses carry no country signal, so the currency
      // resolver stays silent and the pre-filled GBP is never challenged.
      email: `${contactId}@vfixture.example`,
      company_id: companyId,
      companies: { name: company },
    },
  }
}

// The inherited (is_current) version row, exactly the columns the inherit
// select names. Two named recipients, standard pricing, steel, one displayed
// thickness — a fully-valid Recipients continuation.
const OPEN_V1 = {
  id: 'vf-open-v1',
  version_number: 1,
  currency: 'GBP',
  material_id: 'vf-mat-steel',
  displayed_variant_ids: ['vf-var-500'],
  names: ['Asha Rao', 'Ben Cole'],
  ink_names: [],
  material_options: [],
  card_type: 'business' as const,
  custom_quote: false,
  core_colour_id: null,
  front_colour_id: null,
  back_colour_id: null,
  is_variant_round: false,
  is_per_direction_pricing: false,
  has_personalisation: false,
  team_sharing_enabled: false,
  shape: 'recipients',
}

// One front image per recipient (no backs → the form derives one-sided), no
// QR rows. Exactly the shape whose loss the Selection guard must count:
// a 2-name set and 2 carried images.
function imageRow(id: string, name: string): any {
  return {
    id,
    image_path: `vf-fixtures/${id}.jpg`,
    original_filename: `${id}.jpg`,
    associated_name: name,
    material_option: null,
    side: 'front',
    sort_order: 0,
    is_qr_code: false,
    qr_decoded_data: null,
    qr_kind: null,
    qr_vcard_slug: null,
    round_variant_id: null,
  }
}

const PROOFS: Record<
  string,
  { header: any; inherit: any | null; imagesByVersion: Record<string, any[]> }
> = {
  'vf-blank': {
    header: header('vf-contact-blank', 'vf-co-blank', 'Farah Nouri', 'Field & Sons'),
    inherit: null,
    imagesByVersion: {},
  },
  'vf-open': {
    header: header('vf-contact-open', 'vf-co-open', 'Mira Patel', 'Vector & Frame'),
    inherit: OPEN_V1,
    imagesByVersion: {
      'vf-open-v1': [imageRow('vf-img-asha', 'Asha Rao'), imageRow('vf-img-ben', 'Ben Cole')],
    },
  },
}

// .from() queries. Return { data, error: null } to claim, null to fall
// through. Single/maybeSingle claims must hand back the OBJECT (or null),
// list claims an ARRAY — hook results bypass mock-supabase's own
// single-row unwrapping.
export function versionFormQuery(state: HookQueryState): { data: any; error: null; count?: number } | null {
  const { table, select, filters } = state

  // ── Claims keyed on a vf- id carried by the request itself ──────────────
  if (table === 'proofs') {
    const id = filters['eq:id']
    if (vf(id)) {
      const p = PROOFS[id] ?? null
      // Currency-suggestion contact read (select names email).
      if (select.includes('email')) {
        return {
          data: p
            ? {
                contact_id: p.header.contact_id,
                contacts: {
                  email: p.header.contacts.email,
                  company_id: p.header.contacts.company_id,
                },
              }
            : null,
          error: null,
        }
      }
      // Page-chrome header read (select joins companies).
      if (select.includes('companies(')) return { data: p ? p.header : null, error: null }
      return { data: p ? { approved_at: null } : null, error: null }
    }
    // Sibling-project currency reads for our fixture contact/company:
    // no other projects exist, so the resolver gets nothing to suggest.
    if (vf(filters['eq:contact_id']) || vf(filters['eq:contacts.company_id'])) {
      return { data: [], error: null }
    }
    return null
  }

  if (table === 'proof_versions' && vf(filters['eq:proof_id'])) {
    // The inherit read targets is_current and resolves maybeSingle.
    return { data: PROOFS[filters['eq:proof_id']]?.inherit ?? null, error: null }
  }

  if (vf(filters['eq:proof_version_id'])) {
    const versionId = filters['eq:proof_version_id'] as string
    if (table === 'proof_version_images') {
      const proof = Object.values(PROOFS).find((p) => p.imagesByVersion[versionId])
      return { data: proof?.imagesByVersion[versionId] ?? [], error: null }
    }
    // No approvals, no layouts, no round variants on these fixtures.
    if (table === 'proof_name_approvals' || table === 'proof_layouts' || table === 'proof_round_variants') {
      return { data: [], error: null }
    }
    // Variant-round selection lock — maybeSingle.
    if (table === 'proof_events') return { data: null, error: null }
    return null
  }

  if (table === 'material_variants' && vf(filters['eq:material_id'])) {
    return {
      data: MATERIAL_VARIANTS.filter((v) => v.material_id === filters['eq:material_id']),
      error: null,
    }
  }

  if (table === 'material_options' && vf(filters['eq:material_id'])) {
    return { data: [], error: null }
  }

  if (table === 'price_tiers') {
    const ids = filters['in:material_variant_id']
    if (Array.isArray(ids) && ids.length > 0 && ids.every(vf)) {
      const currency = filters['eq:currency']
      return {
        data: PRICE_TIERS.filter(
          (t) => ids.includes(t.material_variant_id) && (!currency || t.currency === currency),
        ),
        error: null,
      }
    }
    return null
  }

  // ── Claims with no vf- id in the request — URL-scoped ───────────────────
  if (!onVersionFormPage()) return null

  if (table === 'materials' && select.includes('requires_ink_names')) {
    // The archived-material rescue read carries an id; the picker list
    // carries only is_active/is_published filters.
    if (filters['eq:id']) {
      return vf(filters['eq:id'])
        ? { data: MATERIALS.find((m) => m.id === filters['eq:id']) ?? null, error: null }
        : null
    }
    return { data: MATERIALS, error: null }
  }

  if (table === 'settings' && select.includes('default_pricing_display')) {
    // .single() — object, not array. Standard + GBP mirror the live
    // defaults so a fresh v1 form starts with both commercial fields set.
    return { data: { default_pricing_display: 'standard', default_currency: 'GBP' }, error: null }
  }

  if (table === 'letterpress_core_colours') {
    return { data: [], error: null }
  }

  if (table === 'personalisation_pricing') {
    // maybeSingle per currency — seed values from migration 000172.
    return { data: { per_card_rate: 0.2, min_charge: 50 }, error: null }
  }

  return null
}

export function versionFormRpc(_name: string, _args?: any): { data: any; error: any } | null {
  // The version forms read everything through the query builder and edge
  // functions — no RPCs — so there is deliberately nothing to claim.
  return null
}

export function versionFormInvoke(name: string, body?: any): { data: any; error: any } | null {
  // Currency suggestion's thread read. An empty thread list keeps the
  // resolver silent (no country signal), so the fixture currency is never
  // challenged mid-test.
  if (name === 'fetch-helpscout-conversation-context' && vf(body?.proof_id)) {
    return { data: { conversation_id: 1, url: 'https://example.invalid/hs', threads: [] }, error: null }
  }
  return null
}
