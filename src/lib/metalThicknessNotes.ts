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
// Shape: a single intro line plus two thickness sets — one shared by
// every standard metal (steel, gold, gun metal, copper, …) at
// 300/500/800µm, and a separate set for Mini Steel at 200/300/500µm.
// The copy is deliberately shared across the metal family rather than
// stored per material, because the physical feel of a given thickness
// is the same whichever metal it is cut from.

export interface ThicknessOption {
  /** Display label, e.g. "300µm". Customer-facing only. */
  label: string
  /** Short weight name, e.g. "Slim". */
  name: string
  /** One-line customer-facing description. */
  description: string
}

export interface MetalThicknessNotes {
  /** Intro paragraph above the thickness list. */
  intro: string
  /** Standard metals: 300 / 500 / 800µm. */
  standard: ThicknessOption[]
  /** Mini Steel: 200 / 300 / 500µm. */
  mini_steel: ThicknessOption[]
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
}

// Pick the right thickness set for a material. Mini Steel has its own
// thinner schedule; every other metal uses the standard set.
export function thicknessSetForMaterial(
  notes: MetalThicknessNotes,
  materialCode: string | null | undefined,
): ThicknessOption[] {
  return materialCode === 'metal_mini_steel' ? notes.mini_steel : notes.standard
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
  return {
    intro,
    standard: normaliseSet(obj.standard, DEFAULT_METAL_THICKNESS_NOTES.standard),
    mini_steel: normaliseSet(obj.mini_steel, DEFAULT_METAL_THICKNESS_NOTES.mini_steel),
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
      return { label: o.label, name: o.name, description: o.description }
    })
    .filter((r): r is ThicknessOption => r !== null)
  return rows.length > 0 ? rows : fallback
}
