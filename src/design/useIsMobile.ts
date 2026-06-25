import { useEffect, useState } from 'react'

// Single source of truth for "are we below the md breakpoint?" (i.e. on
// a phone-width viewport). md = 768px in the Tailwind config used
// throughout the app, so the divider is `< 768px`. Reactive: re-renders
// the consumer when the viewport crosses the boundary (e.g. an iPad
// rotating, or the desktop responsive preview being dragged) so a
// mounted Sheet / popover swaps cleanly without a reload.
//
// Mobile-only UI (BottomTabBar, Sheet, the action / resolve / activity
// sheets) gates on this so it never mounts on desktop; the desktop
// anchored popovers / centred dialogs gate on `!isMobile`. Pure CSS
// (`md:hidden`) handles purely-visual switches, but anything with side
// effects (scroll lock, getBoundingClientRect positioning) needs the JS
// gate so only one variant actually mounts.

const QUERY = '(max-width: 767px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia(QUERY).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return
    const mql = window.matchMedia(QUERY)
    const onChange = () => setIsMobile(mql.matches)
    // Sync once in case the value changed between the lazy initialiser
    // and the effect running (e.g. an SSR fallback of false).
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
