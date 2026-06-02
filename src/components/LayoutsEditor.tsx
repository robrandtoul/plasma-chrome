// Shared Set (collection) layouts editor — used by both the new-version
// form (NewVersionPage) and the edit-version form (EditVersionPage), so
// the two surfaces stay identical. Each row is one titled layout with
// its own images. Images come in two flavours so the same editor serves
// v1 creation (all new files), continuing a collection on a new version
// (prior images carried + new files), and editing a collection in place
// (DB images + new files, with removals diffed on save):
//
//   * existingImages — rows already in proof_version_images (carried
//     from a prior version, or loaded from this version on the edit
//     page). Shown as thumbnails; the × moves the id into
//     removedExistingIds and drops the thumbnail.
//   * newFiles — queued File uploads, handled by VariantDropZone.
//
// The editor owns no business logic — the host page derives the save
// writes (insert / update / delete + carry-forward) from the row model.
// Layout identity for carry-forward + diff lives in sourceLayoutId /
// sourceTitle / sourceImageIds (see LayoutEditRow), never in the title
// or order.

import { VariantDropZone } from './VariantDropZone'

export type LayoutExistingImage = {
  id: string
  imagePath: string
  signedUrl: string
  originalFilename: string | null
}

export type LayoutEditRow = {
  // Client-stable React key.
  key: string
  // The prior/loaded proof_layouts.id this row descends from. On the
  // edit page it's the row's own DB id; on a new version continuing a
  // collection it's the layout the row was seeded from; null on a row
  // added fresh (v1, or a layout added during edit / new version). This
  // is the ONLY thing carry-forward and the edit diff key on — never the
  // title or sort_order, which can both change.
  sourceLayoutId: string | null
  title: string
  // Title at load/seed time. Drives the carry-forward "unchanged" test
  // and the edit-page title diff. '' on fresh rows.
  sourceTitle: string
  // Existing image ids present at load/seed time. Drives the
  // carry-forward "image set unchanged" test. [] on fresh rows.
  sourceImageIds: string[]
  // Currently-kept existing images (already excludes anything removed
  // this session).
  existingImages: LayoutExistingImage[]
  // Existing image ids removed this session — diffed against the DB on
  // save so the edit page deletes exactly those rows.
  removedExistingIds: string[]
  // Queued new uploads.
  newFiles: File[]
}

let uidCounter = 0
function uid(): string {
  // Local id generator — the host passes uuids in for DB rows; this is
  // only for fresh client rows that don't have one yet.
  uidCounter += 1
  return `layout-${uidCounter}-${uidCounter * 7919}`
}

export function makeEmptyLayoutRow(): LayoutEditRow {
  return {
    key: uid(),
    sourceLayoutId: null,
    title: '',
    sourceTitle: '',
    sourceImageIds: [],
    existingImages: [],
    removedExistingIds: [],
    newFiles: [],
  }
}

// Total image count for a row (existing kept + queued new).
export function layoutRowImageCount(row: LayoutEditRow): number {
  return row.existingImages.length + row.newFiles.length
}

export function LayoutsEditor({
  rows,
  onChange,
  submitAttempted,
  editorRef,
  countInvalid,
  titlesInvalid,
  imagesInvalid,
  disabled = false,
}: {
  rows: LayoutEditRow[]
  onChange: (rows: LayoutEditRow[]) => void
  submitAttempted: boolean
  editorRef?: React.RefObject<HTMLDivElement | null>
  // Validity flags computed by the host (so the host's single
  // validations object stays the source of truth). Drive the summary
  // message at the bottom.
  countInvalid: boolean
  titlesInvalid: boolean
  imagesInvalid: boolean
  disabled?: boolean
}) {
  function updateRow(idx: number, patch: Partial<LayoutEditRow>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  return (
    <section
      ref={editorRef}
      className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line"
    >
      <div className="mb-6">
        <h2 className="text-base font-semibold text-ink">Layouts</h2>
        <p className="mt-0.5 text-xs text-ink-mute">
          One titled layout per design in the set (e.g. "ECG card", "Infarction card"). The customer approves every layout. Each layout after the first adds a tooling charge.
        </p>
      </div>

      <ul className="space-y-4">
        {rows.map((row, idx) => {
          const titleInvalid = submitAttempted && row.title.trim().length === 0
          const rowImagesInvalid = submitAttempted && layoutRowImageCount(row) === 0
          return (
            <li key={row.key} className="rounded-xl border border-line bg-canvas p-5">
              <div className="flex items-start gap-3">
                <span className="mt-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-on-ink">
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                    Layout title
                  </label>
                  <input
                    type="text"
                    value={row.title}
                    disabled={disabled}
                    placeholder={idx === 0 ? 'e.g. ECG card' : idx === 1 ? 'e.g. Infarction card' : ''}
                    onChange={(e) => updateRow(idx, { title: e.target.value })}
                    className={[
                      'w-full rounded border bg-surface px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 disabled:opacity-60',
                      titleInvalid
                        ? 'border-out focus:border-out focus:ring-out'
                        : 'border-line focus:border-brand focus:ring-brand',
                    ].join(' ')}
                  />
                  {titleInvalid && (
                    <p className="mt-1.5 text-xs font-medium text-out">Required</p>
                  )}

                  {/* Existing images (carried or loaded from the DB).
                      Each thumbnail's × moves its id into
                      removedExistingIds and drops it from the kept set. */}
                  {row.existingImages.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-3">
                      {row.existingImages.map((img) => (
                        <div key={img.id} className="relative h-24 w-24 overflow-hidden rounded border border-line bg-surface">
                          <img
                            src={img.signedUrl}
                            alt={img.originalFilename ?? 'Layout image'}
                            className="h-full w-full object-cover"
                          />
                          {!disabled && (
                            <button
                              type="button"
                              aria-label="Remove image"
                              onClick={() =>
                                updateRow(idx, {
                                  existingImages: row.existingImages.filter((e) => e.id !== img.id),
                                  removedExistingIds: [...row.removedExistingIds, img.id],
                                })
                              }
                              className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-ink/80 text-xs font-bold text-on-ink hover:bg-ink"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* New uploads for this layout. */}
                  <div className="mt-4">
                    <VariantDropZone
                      label={row.existingImages.length > 0 ? 'Add more images' : 'Layout images'}
                      files={row.newFiles}
                      onAddFiles={(picked) => updateRow(idx, { newFiles: [...row.newFiles, ...picked] })}
                      onRemoveFile={(fi) =>
                        updateRow(idx, { newFiles: row.newFiles.filter((_, fj) => fj !== fi) })
                      }
                      invalid={rowImagesInvalid}
                      invalidText="Add at least one image for this layout."
                    />
                  </div>
                </div>
                {!disabled && rows.length > 2 && (
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((_, i) => i !== idx))}
                    className="shrink-0 text-xs font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
                    aria-label={`Remove layout ${idx + 1}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {!disabled && (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => onChange([...rows, makeEmptyLayoutRow()])}
            className="rounded border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm hover:border-line"
          >
            + Add layout
          </button>
          {(countInvalid || titlesInvalid || imagesInvalid) && (
            <p className="text-xs font-medium text-out">
              {countInvalid
                ? 'Add at least 2 layouts.'
                : titlesInvalid
                  ? 'Every layout needs a title.'
                  : 'Every layout needs at least one image.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
