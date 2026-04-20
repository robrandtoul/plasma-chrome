// Admin-only edge function: soft-delete a user account.
// Stamps profiles.deactivated_at and bans the auth row so sign-in fails.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin, callerId } = check

  let body: { user_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!userId) return json({ error: 'user_id is required' }, 400)
  if (userId === callerId) return json({ error: 'You cannot deactivate your own account' }, 400)

  // 1. Stamp the profile marker first. If this errors the ban hasn't
  //    landed yet so the user's account is still usable.
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ deactivated_at: new Date().toISOString() })
    .eq('id', userId)
  if (profileErr) return json({ error: `Failed to mark deactivated: ${profileErr.message}` }, 500)

  // 2. Ban the auth row — effectively ~100 years. Clearing later uses 'none'.
  const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: '876000h',
  })
  if (banErr) return json({ error: `Failed to block sign-in: ${banErr.message}` }, 500)

  return json({ ok: true })
})
