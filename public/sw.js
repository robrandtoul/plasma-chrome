// Proof Viewer service worker — PUSH NOTIFICATIONS ONLY.
//
// Deliberately has NO `fetch`/caching handler. This is a Vite SPA whose JS/CSS
// bundles are content-hashed; a caching service worker risks serving a stale
// bundle after a deploy. Keeping this worker to push + notification handling
// only means it can never interfere with how the app itself loads.
//
// Three handlers:
//   push                  — show the notification (iOS forbids silent pushes;
//                           we ALWAYS call showNotification).
//   notificationclick     — open / focus the app at the deep-link URL.
//   pushsubscriptionchange — best-effort re-subscribe so the browser keeps a
//                           live subscription; the authenticated page reconciles
//                           and persists the new endpoint on next launch.
//
// This file lives in public/ and is served verbatim at /sw.js (root scope), so
// it controls the whole app. Bump SW_VERSION when you change it to force an
// update on next visit.

const SW_VERSION = 'v1'

// Take over as soon as installed/activated so a freshly-enabled device starts
// receiving pushes without needing a second app launch.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  // Parse the JSON payload the send-push function sent. Fall back to a generic
  // notice if the payload is missing/garbled — iOS revokes push permission
  // after a few pushes that DON'T show a notification, so we must always show
  // something.
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = payload.title || 'Proof Viewer'
  const body = payload.body || 'You have a new update.'
  const url = payload.url || '/'
  // tag coalesces repeat notifications about the same thing (e.g. one proof) so
  // the lock screen stacks rather than floods. renotify re-alerts on update.
  const tag = payload.tag || undefined

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: Boolean(tag),
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  // Build an absolute URL from the worker's scope so a relative path like
  // /proofs/:id resolves correctly.
  const absolute = new URL(target, self.registration.scope).href

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // If an app window is already open, focus it and navigate there.
      for (const client of all) {
        if ('focus' in client) {
          try {
            await client.focus()
            if ('navigate' in client) await client.navigate(absolute)
            return
          } catch {
            // fall through to openWindow
          }
        }
      }
      // Otherwise open a new window. (On iOS a cold open may land on the app's
      // start screen rather than the deep path; the SPA 200-rewrite in
      // public/_redirects keeps deep paths resolving to the app shell.)
      if (self.clients.openWindow) await self.clients.openWindow(absolute)
    })(),
  )
})

self.addEventListener('pushsubscriptionchange', (event) => {
  // Best-effort: the browser rotated the subscription. Re-subscribe with the
  // same VAPID key the old subscription carried so pushes keep arriving. We do
  // NOT write to the database here — the service worker has no auth session.
  // The authenticated page reconciles the live subscription on next launch and
  // persists it. This handler is unreliable on iOS, so it's a backup only.
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription
        const appServerKey =
          old && old.options && old.options.applicationServerKey
        if (!appServerKey) return
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        })
      } catch {
        // Swallow — next app launch reconciles.
      }
    })(),
  )
})
