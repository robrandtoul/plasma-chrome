import { useEffect } from 'react'

// Adds a window keydown listener that fires `handler` on Escape. Used
// by overlays (lightbox, request-changes side panel) to close in a
// consistent way. Pass `deps` if `handler` closes over changing state.
export function useEscape(handler: (e: KeyboardEvent) => void, deps: ReadonlyArray<unknown> = []): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export default useEscape
