import { useEffect } from 'react'

// Global Cmd-K (Ctrl-K on non-Mac) shortcut that opens the quote
// compiler in a new tab. Mounted once at the app shell so any
// authenticated page picks it up without further wiring.
//
// Guards:
// - Skipped when the active element is an input, textarea, or
//   contenteditable region. A designer typing in the dashboard
//   search box should not have their flow hijacked.
// - preventDefault() so Firefox's quick-search default and any
//   browser-level Cmd-K bindings don't fire alongside.
export function useQuoteShortcut() {
  useEffect(() => {
    function isEditable(el: Element | null): boolean {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'k' && e.key !== 'K') return
      if (!(e.metaKey || e.ctrlKey)) return
      if (isEditable(document.activeElement)) return
      e.preventDefault()
      // Safari occasionally treats programmatic Cmd-K opens as a
      // popup and blocks the new tab. window.open returns null in
      // that case; fall back to a same-tab navigation so the
      // shortcut still goes somewhere useful instead of silently
      // doing nothing.
      const w = window.open('/quote', '_blank', 'noopener,noreferrer')
      if (!w) {
        console.warn('[useQuoteShortcut] window.open blocked, falling back to same-tab navigation')
        window.location.assign('/quote')
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
