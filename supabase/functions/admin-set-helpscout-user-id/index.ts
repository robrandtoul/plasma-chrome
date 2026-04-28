// Admin-only edge function: set or clear the per-designer Help Scout
// user id mapping on profiles.helpscout_user_id (migration 000123).
//
// Used by send-helpscout-reply to attribute staff replies to a real
// HS user per-designer, with HELPSCOUT_DEFAULT_USER_ID as the
// fallback when the column is null.
//
// POST body:
//   { userId: string, helpscoutUserId: number | null }
//
// Returns:
//   { status: 'ok' }
//   { status: 'failed', reason, detail? }

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RequestBody = {
  userId?: string
  // null = clear the mapping (designer falls back to default).
  // number = the Help Scout user id; must be a positive integer.
  helpscoutUserId?: number | null
}

type FailReason =
  | 'validation'
  | 'user_not_found'
  | 'update_failed'

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
  if (!UUID_RE.test(userId)) return fail('validation', 'userId must be a valid UUID')

  // helpscoutUserId is null OR a positive integer. Reject 0, negatives,
  // floats, NaN, and any non-number-non-null value.
  const raw = body.helpscoutUserId
  let nextValue: number | null
  if (raw === null) {
    nextValue = null
  } else if (typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) {
    nextValue = raw
  } else {
    return fail(
      'validation',
      'helpscoutUserId must be null or a positive integer',
    )
  }

  // Snapshot the existing profile for the audit row + the user-not-
  // found check. Read full_name + helpscout_user_id; the latter
  // becomes the audit's beforeValue so the log captures the change.
  const { data: target, error: getErr } = await admin
    .from('profiles')
    .select('id, full_name, helpscout_user_id')
    .eq('id', userId)
    .single()
  if (getErr || !target) {
    return fail('user_not_found', getErr?.message ?? 'Profile not found', 404)
  }
  const previousValue = (target as { helpscout_user_id: number | null }).helpscout_user_id ?? null
  const targetLabel = (target as { full_name: string | null }).full_name ?? userId

  const { error: updErr } = await admin
    .from('profiles')
    .update({ helpscout_user_id: nextValue })
    .eq('id', userId)
  if (updErr) return fail('update_failed', updErr.message, 500)

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    // Distinct action strings make it possible to filter the audit
    // log for clears separately from sets — useful when triaging
    // who removed someone's mapping.
    action: nextValue == null
      ? 'user.helpscout_user_id_cleared'
      : 'user.helpscout_user_id_set',
    targetType: 'user',
    targetId: userId,
    targetLabel,
    beforeValue: { helpscout_user_id: previousValue },
    afterValue: { helpscout_user_id: nextValue },
  })

  return json({ status: 'ok' })
})
