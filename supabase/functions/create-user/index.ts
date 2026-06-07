// Admin-only edge function: create a new designer (or admin) account.
// Expects { email, full_name, password } from the Users page's
// Add user dialog.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin, callerId, callerEmail, callerLabel } = check

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
  // immediately. app: 'proofs' stamps the new auth user as belonging to
  // this app so any app-aware provisioning routes to the proofs schema.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { app: 'proofs' },
  })
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'Failed to create auth user' }, 500)
  }

  // Create the proofs profile EXPLICITLY. We do NOT rely on the
  // handle_new_user trigger: the admin API sets app_metadata AFTER
  // inserting the auth.users row, so an app-aware trigger sees no app at
  // insert time and creates nothing. proofs.profiles has NO email column
  // (the email lives on auth.users), and role defaults to 'designer', so
  // we upsert only { id, full_name }. Upsert is idempotent if the trigger
  // ever does run. On failure, roll the auth user back so the system
  // doesn't end up with an orphan.
  const { error: profileErr } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, full_name }, { onConflict: 'id' })
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: `Failed to save profile: ${profileErr.message}` }, 500)
  }

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'user.created',
    targetType: 'user',
    targetId: created.user.id,
    targetLabel: full_name,
    afterValue: { email, full_name, role: 'designer' },
  })

  return json({
    id: created.user.id,
    email: created.user.email,
    full_name,
  })
})
