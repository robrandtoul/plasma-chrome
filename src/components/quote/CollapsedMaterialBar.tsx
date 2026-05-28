// One-line bar shown in place of the full material picker once a
// material has been selected, restoring vertical real estate to the
// spec controls below. Whole bar is a click target — clicking
// re-expands the picker; QuotePage handles the state and the
// search-input refocus on expand.

export function CollapsedMaterialBar({
  materialName,
  onExpand,
}: {
  materialName: string
  onExpand: () => void
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={[
        'group flex w-full items-center justify-between rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line',
        'cursor-pointer text-left transition-colors hover:bg-canvas',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
      ].join(' ')}
      aria-label={`Change material (currently ${materialName})`}
    >
      <span className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
          Material
        </span>
        <span className="text-sm font-medium text-ink">{materialName}</span>
      </span>
      <span className="text-sm text-ink-mute transition-colors group-hover:text-ink">
        Change
      </span>
    </button>
  )
}
