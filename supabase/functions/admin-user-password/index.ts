// Admin-only edge function: trigger a password reset email or directly
// set a user's password. Two modes share one endpoint so the auth-gate +
// audit-log + UUID validation logic stays in one place.
//
//   mode: 'reset_email'  → fires the standard Supabase recovery flow
//   mode: 'set'          → updates the password directly (override case)
//
// Returns { status: 'ok' } on success or { status: 'failed', reason }
// on validation / Supabase auth errors. Network / 5xx fall through as
// non-200 responses, matching the shape used by the proof-action
// function.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'

// Strict UUID matcher — same shape used elsewhere in the codebase.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Floor matches the create-user function's threshold (Supabase's default
// is also 6+ as of v2; we hard-code 8 to be consistent across the admin
// surface).
const MIN_PASSWORD_LENGTH = 8

type RequestBody = {
  userId?: string
  mode?: 'reset_email' | 'set'
  newPassword?: string
}

type FailReason =
  | 'validation'
  | 'user_not_found'
  | 'reset_email_failed'
  | 'set_password_failed'

function fail(reason: FailReason, detail?: string, status = 400) {
  return json({ status: 'failed', reason, ...(detail ? { detail } : {}) }, status)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin, callerId, callerEmail, callerLabel } = check

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return fail('validation', 'Invalid JSON body')
  }

  const userId = typeof body.userId === 'string' ? body.userId : ''
  const mode = body.mode
  if (!UUID_RE.test(userId)) return fail('validation', 'userId must be a valid UUID')
  if (mode !== 'reset_email' && mode !== 'set') {
    return fail('validation', 'mode must be "reset_email" or "set"')
  }

  // Resolve the target user via service role so we have the email for
  // generateLink + a readable label for the audit row. Returns 404
  // shape via 'user_not_found' if the auth row is missing — surfaces
  // an obvious error rather than silently failing the action.
  const { data: target, error: getErr } = await admin.auth.admin.getUserById(userId)
  if (getErr || !target?.user) {
    return fail('user_not_found', getErr?.message ?? 'User not found', 404)
  }
  const targetEmail = target.user.email ?? ''
  if (!targetEmail) {
    return fail('user_not_found', 'Target user has no email on file', 404)
  }

  // Lookup the profile label for a tidier audit entry — matches what
  // create-user / deactivate-user do.
  const { data: targetProfile } = await admin
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .single()
  const targetLabel =
    (targetProfile?.full_name as string | null) ?? targetEmail

  if (mode === 'reset_email') {
    // generateLink with type 'recovery' both creates the recovery link
    // AND triggers Supabase's recovery-email template if SMTP is wired
    // up. The link itself isn't returned to the admin — the customer
    // gets it via email.
    const { error: linkErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: targetEmail,
    })
    if (linkErr) return fail('reset_email_failed', linkErr.message, 500)

    await logAudit(admin, {
      actorId: callerId,
      actorEmail: callerEmail,
      actorLabel: callerLabel,
      action: 'user.password_reset_email_sent',
      targetType: 'user',
      targetId: userId,
      targetLabel,
      metadata: { email: targetEmail },
    })

    return json({ status: 'ok' })
  }

  // mode === 'set' — direct password override.
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(
      'validation',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (updErr) return fail('set_password_failed', updErr.message, 500)

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'user.password_set_directly',
    targetType: 'user',
    targetId: userId,
    targetLabel,
    // Never log the password value itself. The presence of this audit
    // row IS the audit signal — the value is always opaque.
    metadata: { email: targetEmail },
  })

  return json({ status: 'ok' })
})
