import { useEffect, useState } from 'react'

// True once the window has scrolled past `threshold` pixels. Used by the
// DesignerHeader to condense on scroll (tighten padding, tuck the wordmark
// tagline, drop a soft shadow). rAF-throttled so a fast scroll doesn't fire a
// setState on every scroll event; `{ passive: true }` keeps scrolling smooth.
//
// The app scrolls the window/body (html,body { overflow-x: clip } in index.css,
// no inner scroll container), so window.scrollY is the right signal — the same
// scroll context the header's `sticky top-0` binds to.
export function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        setScrolled(window.scrollY > threshold)
        ticking = false
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    // Run once so a page that loads already-scrolled (back-nav, deep link)
    // starts in the correct state rather than waiting for the first scroll.
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])
  return scrolled
}

export default useScrolled
