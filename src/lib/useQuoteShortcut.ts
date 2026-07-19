import { useEffect } from 'react'

// Global keyboard shortcuts for the designer app. Mounted once at the app
// shell so any authenticated page picks them up without further wiring.
//
//   ⌘K / Ctrl-K — open the command palette (search projects, jump to a page)
//   ⌘J / Ctrl-J — open the quote compiler in a new tab
//
// ⌘K USED TO OPEN THE QUOTE COMPILER. That was the app's only global shortcut,
// and it fought the universal meaning of ⌘K — made worse by the "⌘ K" keycap
// rendered inside the header search box, which promised it focused search.
// Reflex reaching for search got a new browser tab instead. ⌘K now opens the
// palette (its meaning everywhere else) and the quote compiler moves to ⌘J,
// which is unclaimed in browsers and keeps a one-key path to a daily tool.
//
// Guards on both:
// - Skipped when the active element is an input, textarea, select or
//   contenteditable region, so typing is never hijacked.
// - preventDefault() so Firefox's quick-search default and any browser-level
//   bindings don't fire alongside.

// Opening the palette from a click rather than the keyboard (the ⌘K badge in
// the header search box). A window event rather than a prop so the badge —
// which sits three components deep inside DesignerChrome → DesignerHeader →
// SearchField — doesn't need a callback threaded down to it from the app shell.
const PALETTE_EVENT = 'pv:open-command-palette'

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT))
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

// `enabled` is false on the public customer pages: those visitors have no
// palette and no quote compiler, so the browser's own ⌘K must keep working.
export function useDesignerShortcuts(onOpenPalette: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return

      if (e.key === 'k' || e.key === 'K') {
        // The palette is a search box, so — unlike the quote shortcut — it is
        // deliberately reachable while a field has focus. Someone half-way
        // through typing in the dashboard's inline search who hits ⌘K means
        // "give me the bigger search", and blocking it there is exactly the
        // case the old binding got wrong.
        e.preventDefault()
        onOpenPalette()
        return
      }

      if (e.key === 'j' || e.key === 'J') {
        if (isEditable(document.activeElement)) return
        e.preventDefault()
        // Safari occasionally treats programmatic opens as a popup and blocks
        // the new tab. window.open returns null in that case; fall back to a
        // same-tab navigation so the shortcut still goes somewhere useful
        // instead of silently doing nothing.
        const w = window.open('/quote', '_blank', 'noopener,noreferrer')
        if (!w) {
          console.warn('[useDesignerShortcuts] window.open blocked, falling back to same-tab navigation')
          window.location.assign('/quote')
        }
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener(PALETTE_EVENT, onOpenPalette)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(PALETTE_EVENT, onOpenPalette)
    }
  }, [onOpenPalette, enabled])
}
