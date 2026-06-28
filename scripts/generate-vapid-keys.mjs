// Generate a VAPID key pair for web push, in the two forms the system needs:
//   * VITE_VAPID_PUBLIC_KEY — the raw P-256 public key (base64url), used by the
//     frontend's pushManager.subscribe(applicationServerKey).
//   * VAPID_KEYS            — the JWK pair { publicKey, privateKey } as JSON,
//     used by the send-push edge function (@negrel/webpush importVapidKeys).
//
// Both come from ONE key pair, so they correspond. Run once and store the
// outputs (frontend env var + Supabase secret). The private half is a SECRET —
// never commit it.
//
//   node scripts/generate-vapid-keys.mjs

import { webcrypto as crypto } from 'node:crypto'

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])

const publicKey = await crypto.subtle.exportKey('jwk', kp.publicKey)
const privateKey = await crypto.subtle.exportKey('jwk', kp.privateKey)
const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey)
const applicationServerKey = Buffer.from(rawPub).toString('base64url')

console.log('\n=== VITE_VAPID_PUBLIC_KEY (Netlify env + .env, frontend) ===')
console.log(applicationServerKey)
console.log('\n=== VAPID_KEYS (Supabase secret, send-push) ===')
console.log(JSON.stringify({ publicKey, privateKey }))
console.log('\n=== VAPID_SUBJECT (Supabase secret) ===')
console.log('mailto:rob@plasmadesign.co.uk')
console.log('')
