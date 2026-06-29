// Shared web-push helpers: VAPID config + the single encrypted send, plus small
// copy utilities (interpolate + clip to iOS limits).
//
// Uses npm:web-push@3.6.7 — the same battle-tested library the Stock Control
// app's notify-scan function already runs in THIS Supabase project, so the
// runtime is proven. (RFC 8291 aes128gcm + VAPID signing; no benefit to rolling
// our own or to an alternative lib.)
//
// ⚠ NAMESPACED secrets. This project is shared by the Proof Viewer, Stock
// Control, and the vCard app, and edge-function secrets are project-wide. Stock
// Control already owns VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT for
// its own push system, so the Proof Viewer uses its OWN distinct keys under a
// PROOFS_ prefix and never touches Stock Control's. The two apps' subscriptions
// are independent (different origins, different VAPID identities).
//
// Required Supabase secrets (set on the project, distinct from Stock Control's):
//   PROOFS_VAPID_PUBLIC_KEY   — base64url P-256 public key (also the frontend's
//                               VITE_VAPID_PUBLIC_KEY; both come from one pair).
//   PROOFS_VAPID_PRIVATE_KEY  — base64url P-256 private key (the JWK "d" value).
//   PROOFS_VAPID_SUBJECT      — contact mailto: (e.g. mailto:rob@plasmadesign.co.uk).

import webpush from 'npm:web-push@3.6.7'

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body: string
  url: string
  tag?: string
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; status: number | null; error: string }

const PUBLIC_KEY = Deno.env.get('PROOFS_VAPID_PUBLIC_KEY') ?? ''
const PRIVATE_KEY = Deno.env.get('PROOFS_VAPID_PRIVATE_KEY') ?? ''
const SUBJECT = Deno.env.get('PROOFS_VAPID_SUBJECT') ?? ''

let configured = false
if (PUBLIC_KEY && PRIVATE_KEY && SUBJECT) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY)
    configured = true
  } catch (err) {
    console.error('[push] setVapidDetails failed:', err)
  }
}

export function pushIsConfigured(): boolean {
  return configured
}

export async function sendPush(target: PushTarget, payload: PushPayload): Promise<SendOutcome> {
  if (!configured) return { ok: false, status: null, error: 'VAPID not configured' }
  const subscription = {
    endpoint: target.endpoint,
    keys: { p256dh: target.p256dh, auth: target.auth },
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 60 * 60 * 24,
    })
    return { ok: true }
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode ?? null
    const error =
      (err as { body?: string })?.body ??
      (err instanceof Error ? err.message : String(err))
    return { ok: false, status, error }
  }
}

export function interpolate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key]
    return v == null ? '' : String(v)
  })
}

export function clip(s: string, max: number): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}
