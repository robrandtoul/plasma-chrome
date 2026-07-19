import { useEffect } from 'react'

// Warn before abandoning a form with unsaved work.
//
// WHY THIS EXISTS. The version forms are the longest in the app — material,
// variant, ink names, recipients, change notes, pricing mode, and a set of
// images that are held in memory as File objects until Save. Nothing was
// persisted or guarded, so every exit route silently discarded the lot:
// the Cancel link, the logo, the nav pills, the mobile tab bar (whose Chat tab
// carries an unread badge that actively invites the tap mid-form), a tab close,
// and lazyWithRetry's location.reload() when a chunk 404s after a deploy —
// which, on a shop that deploys several times a day, is a when-not-if.
//
// TWO MECHANISMS, because one can't cover both cases:
//
//   1. beforeunload — reloads, tab closes, and the lazyWithRetry reload. The
//      browser shows its own generic message; the string is ignored by modern
//      browsers but is still required to trigger the prompt.
//
//   2. A capture-phase click listener for in-app navigation. React Router's
//      useBlocker only works with a data router (createBrowserRouter); this app
//      mounts the declarative <BrowserRouter>, so there is no router-level hook
//      to use. Catching the click on the way down lets us cancel it before the
//      router ever sees it.
//
// window.confirm is deliberate here rather than the app's ConfirmDialog: the
// decision has to be synchronous to cancel the click (and beforeunload is
// browser-native anyway). An async React modal cannot stop a navigation that
// has already been dispatched.
//
// NOT covered: the browser's own Back button. Intercepting that without a data
// router means pushing sentinel history entries, which breaks Forward and can
// trap the user in a loop — worse than the problem. beforeunload plus click
// interception covers every route the review actually found work being lost on.

export function useUnsavedChangesGuard(dirty: boolean, message: string) {
  // Native reload / close / lazyWithRetry.
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      // Legacy browsers keyed the prompt off a returned string.
      e.returnValue = message
      return message
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, message])

  // In-app navigation via any rendered link.
  useEffect(() => {
    if (!dirty) return

    function onClick(e: MouseEvent) {
      // Let the browser handle anything that isn't a plain left-click — a
      // cmd/ctrl/shift click opens a new tab or window and leaves this form
      // exactly where it is, so there is nothing to warn about.
      if (e.defaultPrevented) return
      if (e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

      const anchor = (e.target as Element | null)?.closest?.('a')
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      // Links that leave the app entirely (Help Scout, Xero, Dropbox) and
      // anything explicitly opening a new tab don't destroy the form.
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return
      let url: URL
      try {
        url = new URL(href, window.location.origin)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return
      // Staying on the same page (e.g. a filter link) isn't a loss.
      if (url.pathname === window.location.pathname) return

      if (!window.confirm(message)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    // Capture phase so this runs before React Router's own click handler.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty, message])
}
