// Web-push subscription helpers for the installed iOS/desktop PWA.
//
// The flow, and the iOS rules that shape it:
//   * Push only works in the app once it's added to the Home Screen
//     (isStandalone). In a normal Safari tab PushManager is absent.
//   * Permission must be requested from a real user tap, and a denial is
//     effectively permanent (recoverable only in iOS Settings) — so the UI
//     explains the value before calling enablePush().
//   * The VAPID public key MUST be converted to a Uint8Array before
//     pushManager.subscribe() — passing the base64url string throws on iOS.
//   * We await navigator.serviceWorker.ready (not just register()) before
//     subscribing, or a freshly-installed app can reject the first subscribe.
//
// Subscriptions are written DIRECTLY to proofs.push_subscriptions under RLS
// (the user only ever touches their own rows), keyed on endpoint so a
// re-subscribe upserts.

import { supabase } from './supabase'
import { VAPID_PUBLIC_KEY } from './env'

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'not_installed' | 'not_configured' | 'denied' | 'dismissed' | 'error'; message?: string }

/** True when the browser can do web push at all (SW + Push API + Notifications). */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** True when running as the installed Home-Screen app (iOS requires this). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const mql = window.matchMedia?.('(display-mode: standalone)')
  // navigator.standalone is the iOS-Safari-specific signal for an installed
  // web app; it isn't in the TS DOM lib, hence the cast.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return Boolean(mql?.matches) || iosStandalone
}

/** Whether the VAPID key is configured in this build. */
export function isPushConfigured(): boolean {
  return typeof VAPID_PUBLIC_KEY === 'string' && VAPID_PUBLIC_KEY.length > 0
}

/** Current Notification permission, or 'unsupported'. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

// VAPID base64url string -> Uint8Array, as required by pushManager.subscribe().
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Register the (push-only) service worker. Safe to call on every app launch;
 *  idempotent. No-op when service workers aren't supported. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

async function persistSubscription(sub: PushSubscription): Promise<void> {
  const { data } = await supabase.auth.getUser()
  const userId = data.user?.id
  if (!userId) throw new Error('Not signed in')
  const json = sub.toJSON()
  const p256dh = json.keys?.p256dh
  const authKey = json.keys?.auth
  if (!p256dh || !authKey) throw new Error('Subscription is missing its keys')
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh,
        auth: authKey,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )
  if (error) throw new Error(error.message)
}

/**
 * Ask permission (if needed), subscribe this device, and save it. Must be
 * called from a user-gesture handler on iOS. The caller should first check
 * isPushSupported() + isStandalone() and show the appropriate guidance card.
 */
export async function enablePush(): Promise<EnableResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' }
  if (!isStandalone()) return { ok: false, reason: 'not_installed' }
  if (!isPushConfigured()) return { ok: false, reason: 'not_configured' }

  try {
    const permission = await Notification.requestPermission()
    if (permission === 'denied') return { ok: false, reason: 'denied' }
    if (permission !== 'granted') return { ok: false, reason: 'dismissed' }

    await registerServiceWorker()
    // Wait for the worker to be activated before subscribing — a fresh install
    // can otherwise reject the first subscribe() call.
    const reg = await navigator.serviceWorker.ready

    const existing = await reg.pushManager.getSubscription()
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
      }))

    await persistSubscription(sub)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** Unsubscribe this device and delete its saved row. Used by the per-device
 *  "Turn off on this device" control. */
export async function disablePushOnThisDevice(): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    const endpoint = sub.endpoint
    try {
      await sub.unsubscribe()
    } catch {
      // Even if unsubscribe fails, drop our saved row so we stop sending to it.
    }
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  }
}

/**
 * Reconcile on launch: if this device already has permission + a live
 * subscription, make sure the saved row matches it (re-homes a rotated
 * subscription). This is the reliable complement to the flaky
 * pushsubscriptionchange event. Cheap no-op when nothing's enabled.
 */
export async function reconcileSubscription(): Promise<void> {
  try {
    if (!isPushSupported() || !isStandalone() || !isPushConfigured()) return
    if (Notification.permission !== 'granted') return
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await persistSubscription(sub)
  } catch {
    // Best-effort; a failed reconcile just means the existing row stands.
  }
}
