import { useEffect, useState } from 'react'

// True once the window has scrolled past `threshold` pixels. Used by the
// DesignerHeader to condense on scroll (tighten padding, tuck the wordmark
// tagline, drop a soft shadow). rAF-throttled so a fast scroll doesn't fire a
// setState on every scroll event; `{ passive: true }` keeps scrolling smooth.
//
// Desktop scrolls the window/body; below md the app scrolls inside
// DesignerChrome's #app-scroll frame instead (the tab-bar detach fix), so
// both scroll contexts are observed — whichever one is actually moving
// drives the header.
export function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const frame = document.getElementById('app-scroll')
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        setScrolled(Math.max(window.scrollY, frame?.scrollTop ?? 0) > threshold)
        ticking = false
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    frame?.addEventListener('scroll', onScroll, { passive: true })
    // Run once so a page that loads already-scrolled (back-nav, deep link)
    // starts in the correct state rather than waiting for the first scroll.
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      frame?.removeEventListener('scroll', onScroll)
    }
  }, [threshold])
  return scrolled
}

export default useScrolled
