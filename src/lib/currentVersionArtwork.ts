/**
 * What the proof detail page shows as "the current proof".
 *
 * The hero used to take the first front and the first back of the current
 * version and throw the rest away. On 136 of 571 live current versions that
 * hid artwork (410 images; the worst version carries 18), and on the Brownies
 * Tree wood proof — a Selection round of six species, every image stamped
 * `side='front'` — it showed ONE unlabelled picture of Walnut. The customer
 * had chosen Maple. The order went out as Black Walnut and nothing on the page
 * contradicted it.
 *
 * So the rule is: show every non-QR image of the current version, in the order
 * the designer put them in, and label each one with whatever actually tells it
 * apart from its neighbours.
 *
 * ⚠ A label part is included ONLY when it distinguishes — when the images do
 * not all share the same value for it. A single-recipient version does not
 * caption every tile with that one name, and a one-sided version does not stamp
 * "Front" on six tiles that are all fronts. Captioning what everything shares
 * is noise, and noise is what the designer stops reading.
 *
 * ⚠ `side` is not trusted as structure, only reported as data. All 34 images
 * across the five live set_collections are stamped 'front', backs included, and
 * five live versions store backs under `side='front'` (every filename reads
 * `Proof01_Back_*`). So sides are never used to sort, to group, or to decide a
 * layout; they are captioned only when the stored values differ AND no
 * filename on the version contradicts them.
 *
 * ⚠ The collision tiebreak goes FIRST, not last. A caption is one truncating
 * line, so appending the discriminator puts it off the end — on the live
 * 18-image collection, "METHANE · Proof01A_METHANE_FCP" and
 * "METHANE · Proof01A_METHANE_FCP_Back" both render as
 * "METHANE · Proof01A_METHANE_", which is the exact failure the tiebreak exists
 * to prevent. Leading with it keeps the difference in the visible head.
 *
 * QR rows stay out (`is_qr_code = true`): they are crops of a code, not card
 * faces. Note this set is NOT the same as what `approvedArtwork.ts` hands
 * production — that narrows to the finish actually ordered, while this shows
 * every tab, which is right for a page about the proof rather than the order.
 */

export interface ArtworkImageRow {
  id: string
  image_path: string
  side: 'front' | 'back' | null
  sort_order: number | null
  associated_name: string | null
  material_option: string | null
  original_filename: string | null
  /** Resolved from the proof_round_variants embed — a Selection direction. */
  variant_name: string | null
  /** Resolved from the proof_layouts embed — a Set (collection) design. */
  layout_title: string | null
}

export interface LabelledArtwork {
  id: string
  image_path: string
  side: 'front' | 'back' | null
  /** What tells this card apart. Null when there is nothing to say. */
  label: string | null
}

/** True when the values differ across the set, so naming them adds something. */
function distinguishes(values: (string | null)[]): boolean {
  return new Set<string | null>(values).size > 1
}

/** "Proof01_Walnut.jpg" → "Proof01_Walnut". The last resort for telling two
 *  otherwise identical tiles apart — a designer recognises their own filenames. */
function filenameStem(name: string | null): string | null {
  if (!name) return null
  const stem = name.replace(/\.[^./\\]+$/, '').trim()
  return stem || null
}

const SIDE_LABEL: Record<string, string> = { front: 'Front', back: 'Back' }

/** Does the designer's own filename contradict the stored side? Where the two
 *  disagree we stop asserting sides for the whole version rather than print a
 *  caption we can already see is wrong. Word-boundary matched, so a filename
 *  like "Backdrop" makes no claim either way. */
function filenameContradictsSide(row: ArtworkImageRow): boolean {
  if (!row.side || !row.original_filename) return false
  const name = row.original_filename.toLowerCase()
  const saysBack = /(^|[^a-z])back([^a-z]|$)/.test(name)
  const saysFront = /(^|[^a-z])front([^a-z]|$)/.test(name)
  if (saysBack === saysFront) return false
  return saysBack ? row.side === 'front' : row.side === 'back'
}

/**
 * Order and caption every image of the current version.
 *
 * Order is `sort_order` then `id` — the order the designer authored, with a
 * stable tiebreak because `sort_order` is not unique. Deliberately NOT sorted
 * by side: doing so reverses the designer's own arrangement on versions where
 * the side column is wrong, and it disagrees with the customer page's
 * variant-round ordering.
 */
export function buildCurrentVersionArtwork(
  images: ArtworkImageRow[],
  optionLabels?: Map<string, string>,
): LabelledArtwork[] {
  const rows = [...images].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id),
  )
  if (rows.length === 0) return []

  const optionOf = (r: ArtworkImageRow) =>
    r.material_option ? optionLabels?.get(r.material_option) ?? r.material_option : null

  // Which parts earn their place on this version.
  const useVariant = distinguishes(rows.map((r) => r.variant_name))
  const useLayout = distinguishes(rows.map((r) => r.layout_title))
  const useOption = distinguishes(rows.map(optionOf))
  const useName = distinguishes(rows.map((r) => r.associated_name))
  // Sides are captioned only when they vary AND nothing on the version says
  // the column is lying. One contradiction discredits the column for the whole
  // set — the filenames are the designer's own words, the column is a form field.
  const useSide =
    distinguishes(rows.map((r) => r.side)) && !rows.some(filenameContradictsSide)

  const labelled = rows.map((r) => {
    const parts = [
      useVariant ? r.variant_name : null,
      useLayout ? r.layout_title : null,
      useOption ? optionOf(r) : null,
      useName ? r.associated_name : null,
      useSide ? (r.side ? SIDE_LABEL[r.side] ?? null : null) : null,
    ].filter((p): p is string => !!p && p.trim().length > 0)
    return { row: r, label: parts.join(' · ') || null }
  })

  // Two tiles reading the same thing is the one outcome worse than no label —
  // it asserts they are the same card. Five of eighteen live Selection rounds
  // upload one face once per direction, so this is not hypothetical. The
  // designer's own filename is the tiebreak, and it LEADS: see the header on
  // why appending it puts the whole distinction past the truncation point.
  const counts = new Map<string, number>()
  for (const l of labelled) counts.set(l.label ?? '', (counts.get(l.label ?? '') ?? 0) + 1)

  return labelled.map(({ row, label }) => {
    if ((counts.get(label ?? '') ?? 0) > 1) {
      const stem = filenameStem(row.original_filename)
      if (stem) {
        return {
          id: row.id,
          image_path: row.image_path,
          side: row.side,
          label: label ? `${stem} · ${label}` : stem,
        }
      }
    }
    return { id: row.id, image_path: row.image_path, side: row.side, label }
  })
}

/**
 * Columns for the artwork grid. One image fills the panel; anything else pairs
 * up; a comparison set of five or more goes three across so a Selection round
 * can be read side by side without scrolling.
 */
export function artworkGridColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1
  if (count >= 5) return 3
  return 2
}
