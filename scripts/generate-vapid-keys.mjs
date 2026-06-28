// Generate a VAPID key pair for web push, in the forms the system needs. Uses
// the npm `web-push` library convention (separate base64url public + private
// keys), matching the proven pattern already running in this Supabase project.
//
// ⚠ The Supabase secrets are NAMESPACED (PROOFS_ prefix) because this project is
// shared with the Stock Control app, which already owns VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY / VAPID_SUBJECT for ITS push system. Never reuse or
// overwrite those — the Proof Viewer uses its own PROOFS_ keys.
//
// All outputs come from ONE key pair, so they correspond. Run once and store
// them. The private key is a SECRET — never commit it.
//
//   node scripts/generate-vapid-keys.mjs

import { webcrypto as crypto } from 'node:crypto'

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])

const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey)
const publicKey = Buffer.from(rawPub).toString('base64url') // uncompressed point
const privateKey = privateJwk.d // the raw private scalar, already base64url

console.log('\n=== Netlify env (Proof Viewer site, frontend) ===')
console.log('VITE_VAPID_PUBLIC_KEY =', publicKey)
console.log('\n=== Supabase secrets (NAMESPACED — do NOT touch Stock Control\'s VAPID_*) ===')
console.log('PROOFS_VAPID_PUBLIC_KEY  =', publicKey)
console.log('PROOFS_VAPID_PRIVATE_KEY =', privateKey)
console.log('PROOFS_VAPID_SUBJECT     =', 'mailto:rob@plasmadesign.co.uk')
console.log('')
