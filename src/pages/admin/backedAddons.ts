import { supabase } from '../../lib/supabase'

// Add-ons whose data layer is `material_option_surcharges`, not
// `add_on_prices`. The admin Mirror/Brushed editor and the admin
// pricing index both branch on this map: the editor to fan out
// loads/saves across the four backing schedules, the index to
// decide whether the "Needs pricing" badge fires from the right
// table.
//
// Adding a new entry here requires the same two changes anywhere
// that reads add_on_prices on behalf of an add-on.
export const MATERIAL_OPTION_BACKED_ADDONS: Record<string, { materialCodes: string[]; optionCodes: string[] }> = {
  metal_finish_upgrade: {
    materialCodes: ['metal_steel', 'metal_gold'],
    optionCodes: ['brushed', 'mirror'],
  },
}

export function isBackedAddon(code: string): boolean {
  return code in MATERIAL_OPTION_BACKED_ADDONS
}

// Resolve the underlying material_option ids for a backed add-on.
// Returns an empty array for non-backed codes or when the linked
// materials/options aren't found. Callers gate on length > 0
// before issuing dependent queries.
export async function resolveBackingOptionIds(addOnCode: string): Promise<string[]> {
  const cfg = MATERIAL_OPTION_BACKED_ADDONS[addOnCode]
  if (!cfg) return []
  const { data: mats, error: matErr } = await supabase
    .from('materials')
    .select('id, code')
    .in('code', cfg.materialCodes)
  if (matErr) throw matErr
  const matIds = (mats ?? []).map((m: { id: string }) => m.id)
  if (matIds.length === 0) return []
  const { data: opts, error: optErr } = await supabase
    .from('material_options')
    .select('id, code, material_id')
    .in('material_id', matIds)
    .in('code', cfg.optionCodes)
  if (optErr) throw optErr
  return (opts ?? []).map((o: { id: string }) => o.id)
}
