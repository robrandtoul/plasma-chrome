export function PageDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-ink/30">
      <div className="rounded-2xl bg-surface px-10 py-8 shadow-xl ring-1 ring-line">
        <p className="text-center text-base font-semibold text-ink">
          Drop images to add to this version
        </p>
      </div>
    </div>
  )
}
