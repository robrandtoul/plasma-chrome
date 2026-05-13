import type { VariantType } from '../../lib/quote/types'

// Spec readout — a small card sitting under the headline price
// that lists the spec the designer is quoting, in label/value rows
// the designer can read aloud while confirming with the customer.
//
// Replaces the previous bullet-separated "Quoting: …" line. The
// card layout adds a missing Finish row that the inline version
// dropped on the floor — a real bug, since the finish surcharge
// was being applied to the price but not surfaced in the spec, so
// a designer reading the summary back would never mention it.
//
// Currency is intentionally omitted — the headline price already
// carries it in big type immediately above.
//
// Rows render in this order, each conditional:
//
//   Material      always
//   Thickness/    contextual to variant_type. Thickness materials
//   Inks          render "Thickness: 500 micron"; ink-count
//                 materials render "Inks: 4"; default-variant
//                 materials (Wood, Acrylic, Carbon Fibre) hide
//                 the row entirely. variant_type === 'finish'
//                 (Standard Paper) renders as "Finish".
//   Finish        only when the material has option surcharges
//                 (Steel and Gold today). Value is the active
//                 option's display_name as-stored, including the
//                 base "Natural" — designers should hear "natural
//                 finish" called out as much as "mirror finish",
//                 not have it omitted as a default.
//   Quantity      always — formatted as "{n} cards"
//   Layouts       only when names > 1 — value is just the integer
//
// The card stays visible in the custom-quote bailout state — the
// spec is still the spec; only the price column swaps out.

export interface SpecSummaryProps {
  materialName: string | null
  variantType: VariantType | null
  variantDisplayName: string | null
  // Active option's display name when the material has a finish
  // dimension at all. Null when the material has no finish
  // options (Letterpress, plastics, paper standard, wood,
  // acrylic, carbon fibre) — in that case the row is hidden.
  // Includes the base option (Natural) for materials that DO
  // have a finish dimension, so it's surfaced even when no
  // surcharge applies.
  finishName: string | null
  quantity: number | null
  names: number
  // Migration 000172. When true, surfaces a "Personalisation:
  // Unique per card" row. Replaces the Layouts row since
  // personalisation and split-name layouts are mutually exclusive
  // in this form.
  personalisationActive: boolean
}

export function SpecSummary({
  materialName,
  variantType,
  variantDisplayName,
  finishName,
  quantity,
  names,
  personalisationActive,
}: SpecSummaryProps) {
  if (!materialName) return null

  // Variant row resolution. ink_count materials render just the
  // integer; thickness + finish-variant materials render the
  // display_name (already stored lowercase, e.g. "500 micron").
  // Default-variant materials drop out of the card entirely.
  let variantRow: { label: string; value: string } | null = null
  if (variantDisplayName && variantType && variantType !== 'default') {
    if (variantType === 'thickness') {
      variantRow = { label: 'Thickness', value: variantDisplayName }
    } else if (variantType === 'ink_count') {
      // "4 Inks" → "4". Defensive parse — fall back to the raw
      // display_name if no leading integer exists for some reason.
      const m = variantDisplayName.match(/^\d+/)
      variantRow = { label: 'Inks', value: m ? m[0] : variantDisplayName }
    } else if (variantType === 'finish') {
      // Standard Paper's standard / uv_spot / foiling variants —
      // labelled "Finish" here, distinct from the option-driven
      // Finish row below (Standard Paper has no option surcharges,
      // so the option-driven row never appears for it).
      variantRow = { label: 'Finish', value: variantDisplayName }
    }
  }

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p className="mb-3 text-sm font-medium text-gray-500">Quoting</p>
      <dl className="space-y-2 text-sm">
        <Row label="Material" value={materialName} />
        {variantRow && <Row label={variantRow.label} value={variantRow.value} />}
        {finishName && <Row label="Finish" value={finishName} />}
        {quantity != null && <Row label="Quantity" value={`${quantity.toLocaleString()} cards`} />}
        {names > 1 && !personalisationActive && <Row label="Layouts" value={String(names)} />}
        {personalisationActive && <Row label="Personalisation" value="Unique per card" />}
      </dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900 tabular-nums">{value}</dd>
    </div>
  )
}
