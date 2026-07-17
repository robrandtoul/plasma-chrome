import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

// Drop-in replacement for React.lazy that survives a mid-session deploy.
//
// Once routes are code-split, each page is its own content-hashed chunk. If a
// deploy lands while a designer has the app open, their already-loaded
// index.html still points at the OLD chunk hashes; navigating to a route whose
// chunk hasn't loaded yet then requests a filename that no longer exists on the
// CDN, and the dynamic import rejects — a blank screen. This shop deploys many
// times a day, so that race is a when-not-if.
//
// The fix: on the first failed import, force one full page reload. That fetches
// the fresh index.html with the new chunk hashes, and the navigation succeeds.
// A sessionStorage flag bounds it to a SINGLE reload so a chunk that is
// genuinely missing (build error, CDN outage) surfaces the real error instead
// of looping.
//
// The flag is keyed PER CHUNK. A single global flag is unsafe: nested routes
// (e.g. /admin/<page>) mount two lazy chunks under one Suspense — the parent
// layout AND the child page — on the same render. If one resolves and the
// other is permanently missing, a global flag would let the resolving sibling
// clear the flag the failing sibling just set, re-arming the reload every pass
// → an infinite loop instead of a thrown error. Per-chunk keys make each
// chunk's one-reload guarantee independent.
//
// The key MUST be a stable literal (the component name), NOT anything derived
// from the chunk hash — the flag has to survive the reload, and the hash
// changes across the deploy that triggered it.
//
// All sessionStorage access is guarded — a blocked store (private mode, strict
// settings) degrades to plain React.lazy (reload on every first failure, which
// the deploy race still self-heals on the single reload).

function flagKey(key: string): string {
  return `chunk-reload:${key}`
}

function readFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(flagKey(key)) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) sessionStorage.setItem(flagKey(key), '1')
    else sessionStorage.removeItem(flagKey(key))
  } catch {
    // No-op: store unavailable. Worst case we lose the one-reload guard,
    // which only matters in the rare genuine-missing-chunk case.
  }
}

// ComponentType<any> (not <unknown>) mirrors React.lazy's own typing —
// function-parameter contravariance means a component with typed props is
// not assignable to ComponentType<unknown>, which broke the first page to
// take a prop (DashboardPage's activityView).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  key: string,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await importer()
      writeFlag(key, false)
      return mod
    } catch (err) {
      if (!readFlag(key)) {
        writeFlag(key, true)
        window.location.reload()
        // Never resolve: keep the Suspense fallback up through the reload
        // instead of flashing React's error boundary.
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}
