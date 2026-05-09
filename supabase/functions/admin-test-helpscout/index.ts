// Admin-only edge function: tests the Help Scout integration end-to-end.
//
// Runs the OAuth client_credentials flow against HELPSCOUT_APP_ID +
// HELPSCOUT_APP_SECRET, then hits GET /v2/mailboxes to confirm the
// resulting access token actually works and the API is reachable.
// Returns a structured result so the admin UI can show a green dot
// + mailbox name on success or a specific failure reason otherwise.
//
// Why /v2/mailboxes: a benign authenticated endpoint that returns a
// short payload, exists on every Help Scout account, and double-
// duties as a useful diagnostic — surfacing the mailbox name back to
// the admin confirms not just "API reachable" but "API connected to
// the project we expect".
//
import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { getAccessToken, HsError } from '../_shared/helpscout.ts'

type SuccessResult = {
  status: 'connected'
  verifiedAt: string
  mailboxName?: string
}

type FailureReason =
  | 'missing_env_vars'
  | 'auth_failed'
  | 'api_unreachable'
  | 'unexpected_error'

type FailureResult = {
  status: 'failed'
  reason: FailureReason
  detail?: string
}

function fail(reason: FailureReason, detail?: string): Response {
  const body: FailureResult = { status: 'failed', reason, ...(detail ? { detail } : {}) }
  return json(body)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check

  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim() ?? ''
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim() ?? ''
  if (!appId || !appSecret) {
    return fail('missing_env_vars', 'HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET must be set in Supabase secrets')
  }

  // OAuth — distinct failure mode for credential rejection so the UI
  // can point the admin at HELPSCOUT_APP_SECRET specifically.
  let token: string
  try {
    token = await getAccessToken(appId, appSecret)
  } catch (err) {
    const msg = (err as Error).message
    // Help Scout returns 400/401 from the token endpoint when the
    // client_id/secret pair is wrong; treat anything <500 as auth
    // failure, anything else as transport/api unreachable. The shared
    // helper throws HsError with the upstream status, so we can branch
    // on err.status directly rather than regex-matching the message.
    if (err instanceof HsError && err.status >= 400 && err.status < 500) {
      return fail('auth_failed', msg)
    }
    return fail('api_unreachable', msg)
  }

  // Mailboxes endpoint — confirms the token works and surfaces a
  // mailbox name as a diagnostic. The shape is { _embedded: { mailboxes: [...] } }
  // per https://developer.helpscout.com/mailbox-api/endpoints/mailboxes/list/
  let mailboxName: string | undefined
  try {
    const resp = await fetch('https://api.helpscout.net/v2/mailboxes', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (resp.status === 401 || resp.status === 403) {
      const text = await resp.text().catch(() => '')
      return fail('auth_failed', `mailboxes (${resp.status}): ${text.slice(0, 240)}`)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return fail('api_unreachable', `mailboxes (${resp.status}): ${text.slice(0, 240)}`)
    }
    const data = await resp.json().catch(() => null) as
      | { _embedded?: { mailboxes?: Array<{ name?: string }> } }
      | null
    const first = data?._embedded?.mailboxes?.[0]
    if (first?.name && typeof first.name === 'string') {
      mailboxName = first.name
    }
  } catch (err) {
    return fail('api_unreachable', (err as Error).message)
  }

  const success: SuccessResult = {
    status: 'connected',
    verifiedAt: new Date().toISOString(),
    ...(mailboxName ? { mailboxName } : {}),
  }
  return json(success)
})
