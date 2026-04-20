// Admin-only edge function: undo a deactivation.
// Clears profiles.deactivated_at and lifts the auth ban.

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
  if (userId === callerId) return json({ error: 'You cannot reactivate your own account' }, 400)

  const { error: unbanErr } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  })
  if (unbanErr) return json({ error: `Failed to lift sign-in ban: ${unbanErr.message}` }, 500)

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ deactivated_at: null })
    .eq('id', userId)
  if (profileErr) return json({ error: `Failed to clear deactivation: ${profileErr.message}` }, 500)

  return json({ ok: true })
})
