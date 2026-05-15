// Per-table config for the marketing-site price-list pages, derived
// verbatim from price-list-tables-config.json (the verified per-table
// mapping from the 2026-05-15 parity audit). The golden-master price
// arrays in that JSON file are NOT mirrored here — those exist only
// for the test harness's data check (see ./golden-master.ts), not for
// rendering.
//
// Each entry pins:
//   key             — the `data-price-table` value on the Squarespace
//                     placeholder div, AND the material_code to look up
//                     in the RPC payload.
//   title           — display label (currently informational only —
//                     the live tables don't render a caption; reserved
//                     so it can be surfaced later without a schema
//                     change).
//   material_code   — the materials.code to read from the RPC payload.
//                     Identical to `key` for every current table; kept
//                     as a separate field so a future table that
//                     re-uses the same material under a different
//                     placeholder key doesn't need a workaround.
//   dimension       — how the table's columns map to variants:
//                       'ink_count'  → column key is the ink_count int
//                       'thickness'  → column key is the leading
//                                       micron number on the variant
//                                       display_name
//                       'finish'     → column key is the variant code
//                                       ('standard' | 'uv_spot' | 'foiling')
//                       'default'    → single active variant; one
//                                       blank-header price column
//   column_headers  — verbatim header text (kept identical to the live
//                     CommonNinja embed so the swap is visually a
//                     no-op).
//   column_match    — the per-column lookup keys, aligned 1:1 with
//                     column_headers.
//   quantities      — the rows to render, in order. No interpolation;
//                     anything outside this list is ignored.
//   surcharge_column — optional extra column on the right-hand side.
//                      Three shapes today, all rendered as 'add £X':
//                        { type: 'metal_finish' }
//                          → material_option_surcharges for the
//                            material's brushed/mirror options (the
//                            two are seeded identically, so either
//                            gives the figure).
//                        { type: 'cnc', source_material_code }
//                          → source_material_code total minus the
//                            base material's total at the same qty.
//                        { type: 'gilding', source_material_code }
//                          → as above; the difference is constant
//                            across ink counts so the script computes
//                            it once per qty row.

export type Dimension = 'ink_count' | 'thickness' | 'finish' | 'default'

export type SurchargeColumn =
  | { type: 'metal_finish'; header: string }
  | { type: 'cnc'; header: string; source_material_code: string }
  | { type: 'gilding'; header: string; source_material_code: string }

export interface TableConfig {
  key: string
  title: string
  material_code: string
  dimension: Dimension
  column_headers: string[]
  column_match: Array<string | number>
  quantities: number[]
  surcharge_column: SurchargeColumn | null
}

export const TABLES: TableConfig[] = [
  {
    key: 'plastic_translucent',
    title: 'Translucent Plastic Cards',
    material_code: 'plastic_translucent',
    dimension: 'ink_count',
    column_headers: ['1 ink', '2 inks', '3 inks', '4 inks'],
    column_match: [1, 2, 3, 4],
    quantities: [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
    surcharge_column: null,
  },
  {
    key: 'plastic_tinted',
    title: 'Tinted Plastic Cards',
    material_code: 'plastic_tinted',
    dimension: 'ink_count',
    column_headers: ['1 ink', '2 inks', '3 inks', '4 inks'],
    column_match: [1, 2, 3, 4],
    quantities: [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
    surcharge_column: null,
  },
  {
    key: 'plastic_satin',
    title: 'Satin Plastic Cards',
    material_code: 'plastic_satin',
    dimension: 'ink_count',
    column_headers: ['1 ink', '2 inks', '3 inks', '4 inks'],
    column_match: [1, 2, 3, 4],
    quantities: [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
    surcharge_column: null,
  },
  {
    key: 'plastic_full_colour',
    title: 'Full Colour Plastic Cards',
    material_code: 'plastic_full_colour',
    dimension: 'thickness',
    column_headers: ['420 micron thick', '680 micron thick', '760 micron thick'],
    column_match: ['420', '680', '760'],
    quantities: [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000],
    surcharge_column: null,
  },
  {
    key: 'wood',
    title: '3mm Wooden Cards',
    material_code: 'wood',
    dimension: 'default',
    column_headers: [''],
    column_match: ['default'],
    quantities: [50, 75, 100, 125, 150, 175, 200, 250, 300, 400, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'carbon_fibre',
    title: 'Carbon Fibre',
    material_code: 'carbon_fibre',
    dimension: 'default',
    column_headers: [''],
    column_match: ['default'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: {
      type: 'cnc',
      header: 'CNC cutting',
      source_material_code: 'carbon_fibre_cnc',
    },
  },
  {
    key: 'acrylic',
    title: '3mm Perspex Cards',
    material_code: 'acrylic',
    dimension: 'default',
    column_headers: [''],
    column_match: ['default'],
    quantities: [50, 75, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'metal_steel',
    title: 'Stainless Steel Cards',
    material_code: 'metal_steel',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: {
      type: 'metal_finish',
      header: 'optional mirror or brushed finish',
    },
  },
  {
    key: 'metal_mini_steel',
    title: 'Mini Metal Cards',
    material_code: 'metal_mini_steel',
    dimension: 'thickness',
    column_headers: ['200 micron thick', '300 micron thick', '500 micron thick'],
    column_match: ['200', '300', '500'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'metal_gold',
    title: 'Gold Metal Cards',
    material_code: 'metal_gold',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: {
      type: 'metal_finish',
      header: 'optional mirror or brushed finish',
    },
  },
  {
    key: 'metal_matte_black',
    title: 'Matte Black Metal Cards',
    material_code: 'metal_matte_black',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'metal_matte_white',
    title: 'Matte White Metal Cards',
    material_code: 'metal_matte_white',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'metal_copper',
    title: 'Copper Metal Cards',
    material_code: 'metal_copper',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'metal_gun_metal',
    title: 'GunMetal Cards',
    material_code: 'metal_gun_metal',
    dimension: 'thickness',
    column_headers: ['300 micron thick', '500 micron thick', '800 micron thick'],
    column_match: ['300', '500', '800'],
    quantities: [50, 100, 150, 200, 250, 500, 750, 1000],
    surcharge_column: null,
  },
  {
    key: 'paper_letterpress',
    title: 'Letterpress Cards',
    material_code: 'paper_letterpress',
    dimension: 'ink_count',
    column_headers: ['1 ink', '2 inks', '3 inks', '4 inks'],
    column_match: [1, 2, 3, 4],
    quantities: [100, 250, 500, 750, 1000, 1500, 2000],
    surcharge_column: {
      type: 'gilding',
      header: 'Optional gilded edges',
      source_material_code: 'paper_letterpress_gilded',
    },
  },
  {
    key: 'paper_standard',
    title: 'Standard Cards',
    material_code: 'paper_standard',
    dimension: 'finish',
    column_headers: ['Standard', 'with UV spot', 'with foiling'],
    column_match: ['standard', 'uv_spot', 'foiling'],
    quantities: [250, 500, 1000, 2000, 3000, 5000, 10000],
    surcharge_column: null,
  },
]
