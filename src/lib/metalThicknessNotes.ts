// Shared types + default copy for the customer-facing metal Thickness
// card (the "About this material → Thickness" panel on the proof page).
//
// The copy is admin-editable (migration 000199 stores it as the
// settings.metal_thickness_notes JSONB column, surfaced to the customer
// page via the public_settings() RPC). These defaults are the seed the
// migration writes AND the runtime fallback used by publicSettings.ts
// when the column is null / the RPC is unreachable, so the panel always
// renders readable copy. Keep this in lockstep with the migration seed.
//
// Shape: a single intro line plus three thickness sets — one shared by
// every standard metal (steel, gold, gun metal, copper, …) at
// 300/500/800µm, a separate set for Mini Steel at 200/300/500µm, and a
// set for Full Colour Plastic at 420/680/760µm (with its own intro,
// since the shared intro line reads "Metal cards are…"). The copy is
// deliberately shared across each material family rather than stored
// per material, because the physical feel of a given thickness is the
// same whichever metal it is cut from.

export interface ThicknessOption {
  /** Display label, e.g. "300µm". Customer-facing only. */
  label: string
  /** Short weight name, e.g. "Slim". */
  name: string
  /** One-line customer-facing description. */
  description: string
  /**
   * Optional recommendation badge shown on the pay-page thickness chooser
   * (open-spec orders), e.g. "Most popular". Editable via the same
   * settings.metal_thickness_notes JSONB: omit the key to inherit this
   * default, set it to "" to remove the badge entirely.
   */
  badge?: string
}

export interface MetalThicknessNotes {
  /** Intro paragraph above the thickness list (metal sets). */
  intro: string
  /** Standard metals: 300 / 500 / 800µm. */
  standard: ThicknessOption[]
  /** Mini Steel: 200 / 300 / 500µm. */
  mini_steel: ThicknessOption[]
  /** Full Colour Plastic: 420 / 680 / 760µm. */
  full_colour_plastic: ThicknessOption[]
  /** Intro paragraph for the Full Colour Plastic set (the shared intro is metal-worded). */
  full_colour_plastic_intro: string
}

export const DEFAULT_METAL_THICKNESS_NOTES: MetalThicknessNotes = {
  intro:
    'Metal cards are available in three thicknesses. The pricing table to the left shows the cost for each — choose the weight that suits you best.',
  standard: [
    {
      label: '300µm',
      name: 'Slim',
      description:
        'The same thickness as a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
    },
    {
      label: '500µm',
      name: 'Mid-weight',
      description:
        'Noticeably more substantial than card stock, with a satisfying presence in the hand.',
      badge: 'Most popular',
    },
    {
      label: '800µm',
      name: 'Substantial',
      description:
        'The thickness of a bank card — the option that commands attention the moment it is handed over. Rigid and reassuringly weighty.',
    },
  ],
  mini_steel: [
    {
      label: '200µm',
      name: 'Slim',
      description:
        'Slightly thinner than a standard paper business card, but with the rigidity of a credit card — because it\'s solid steel throughout.',
    },
    {
      label: '300µm',
      name: 'Mid-weight',
      description:
        'Noticeably more rigid than card stock, with a satisfying presence in the hand.',
    },
    {
      label: '500µm',
      name: 'Substantial',
      description:
        'The thickest option — it commands attention the moment it is handed over. Rigid and reassuringly weighty.',
    },
  ],
  full_colour_plastic: [
    {
      label: '420µm',
      name: 'Lightweight',
      description:
        'Considerably thinner and much more flexible — ideal where weight is a critical factor, such as postal promotional campaigns.',
    },
    {
      label: '680µm',
      name: 'Mid-weight',
      description:
        'Slightly thinner and more flexible than a credit card. The difference is subtle, and usually only noticeable when comparing the two side by side.',
    },
    {
      label: '760µm',
      name: 'Credit card',
      description:
        'Our thickest plastic card — the same thickness as a standard credit card.',
      badge: 'Most popular',
    },
  ],
  full_colour_plastic_intro:
    'Full colour plastic cards are available in three thicknesses. A micron is one-thousandth of a millimetre — choose the weight that suits your application best.',
}

// Which materials get a thickness guide (the proof-page panel and the
// pay-page chooser copy). Kept here so the two gates can't drift apart:
// the metal family plus Full Colour Plastic, the one non-metal material
// with a real thickness choice (420/680/760µm variants).
export function hasThicknessGuide(materialCode: string | null | undefined): boolean {
  return !!materialCode && (materialCode.startsWith('metal_') || materialCode === 'plastic_full_colour')
}

// Pick the right thickness set for a material. Mini Steel has its own
// thinner schedule and Full Colour Plastic its own; every other metal
// uses the standard set.
export function thicknessSetForMaterial(
  notes: MetalThicknessNotes,
  materialCode: string | null | undefined,
): ThicknessOption[] {
  if (materialCode === 'plastic_full_colour') return notes.full_colour_plastic
  return materialCode === 'metal_mini_steel' ? notes.mini_steel : notes.standard
}

// Matching intro paragraph — the shared intro line is worded for metal,
// so Full Colour Plastic carries its own.
export function thicknessIntroForMaterial(
  notes: MetalThicknessNotes,
  materialCode: string | null | undefined,
): string {
  return materialCode === 'plastic_full_colour' ? notes.full_colour_plastic_intro : notes.intro
}

// Defensive normaliser for whatever the RPC returns. Falls back to the
// defaults field-by-field so a partially-populated or malformed JSON
// blob can never blank the panel. Each set must be a non-empty array of
// well-shaped rows or the default set is used wholesale.
export function normaliseMetalThicknessNotes(raw: unknown): MetalThicknessNotes {
  if (!raw || typeof raw !== 'object') return DEFAULT_METAL_THICKNESS_NOTES
  const obj = raw as Record<string, unknown>
  const intro =
    typeof obj.intro === 'string' && obj.intro.trim().length > 0
      ? obj.intro
      : DEFAULT_METAL_THICKNESS_NOTES.intro
  const plasticIntro =
    typeof obj.full_colour_plastic_intro === 'string' && obj.full_colour_plastic_intro.trim().length > 0
      ? obj.full_colour_plastic_intro
      : DEFAULT_METAL_THICKNESS_NOTES.full_colour_plastic_intro
  return {
    intro,
    standard: normaliseSet(obj.standard, DEFAULT_METAL_THICKNESS_NOTES.standard),
    mini_steel: normaliseSet(obj.mini_steel, DEFAULT_METAL_THICKNESS_NOTES.mini_steel),
    full_colour_plastic: normaliseSet(
      obj.full_colour_plastic,
      DEFAULT_METAL_THICKNESS_NOTES.full_colour_plastic,
    ),
    full_colour_plastic_intro: plasticIntro,
  }
}

function normaliseSet(raw: unknown, fallback: ThicknessOption[]): ThicknessOption[] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback
  const rows = raw
    .map((r) => {
      if (!r || typeof r !== 'object') return null
      const o = r as Record<string, unknown>
      if (typeof o.label !== 'string' || typeof o.name !== 'string' || typeof o.description !== 'string') {
        return null
      }
      // Badge: an explicit string in the stored JSON wins ("" removes it); a row
      // without the key inherits the default badge for the same label, so the
      // live rows seeded before badges existed still show "Most popular".
      const fallbackBadge = fallback.find((f) => f.label === o.label)?.badge
      const badge =
        'badge' in o
          ? (typeof o.badge === 'string' && o.badge.trim() ? o.badge.trim() : undefined)
          : fallbackBadge
      return { label: o.label, name: o.name, description: o.description, ...(badge ? { badge } : {}) }
    })
    .filter((r): r is ThicknessOption => r !== null)
  return rows.length > 0 ? rows : fallback
}
