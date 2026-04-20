// Admin-only edge function: create a new designer (or admin) account.
// Expects { email, full_name, password } from the Users page's
// Add user dialog.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin } = check

  let body: { email?: string; full_name?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const full_name = typeof body.full_name === 'string' ? body.full_name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email) return json({ error: 'email is required' }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400)
  if (!full_name) return json({ error: 'full_name is required' }, 400)
  if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

  // Create the auth user. email_confirm: true skips the verification email
  // — the admin is sharing credentials out-of-band so the user can sign in
  // immediately.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'Failed to create auth user' }, 500)
  }

  // The handle_new_user trigger has already inserted a profile row (id only).
  // Fill in the full_name now. On failure, roll the auth user back so the
  // system doesn't end up with an orphan.
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ full_name })
    .eq('id', created.user.id)
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: `Failed to save profile: ${profileErr.message}` }, 500)
  }

  return json({
    id: created.user.id,
    email: created.user.email,
    full_name,
  })
})
