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
        'group flex w-full items-center justify-between rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200',
        'cursor-pointer text-left transition-colors hover:bg-gray-50',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1',
      ].join(' ')}
      aria-label={`Change material (currently ${materialName})`}
    >
      <span className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          Material
        </span>
        <span className="text-sm font-medium text-gray-900">{materialName}</span>
      </span>
      <span className="text-sm text-gray-500 transition-colors group-hover:text-gray-900">
        Change
      </span>
    </button>
  )
}
