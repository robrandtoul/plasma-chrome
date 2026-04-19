export function PageDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30">
      <div className="rounded-2xl bg-white px-10 py-8 shadow-xl ring-1 ring-gray-200">
        <p className="text-center text-base font-semibold text-gray-900">
          Drop images to add to this version
        </p>
      </div>
    </div>
  )
}
