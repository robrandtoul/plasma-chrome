// Shared helpers for the admin-only edge functions. Each function is
// admin-gated: it must validate the caller's JWT, confirm they have the
// admin role, and reject otherwise. Centralising the check here keeps
// the individual function bodies focused on their actual work.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Let the browser read the Content-Disposition filename so the frontend
  // download helper can name the saved file correctly.
  'Access-Control-Expose-Headers': 'Content-Disposition',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

export interface CallerContext {
  /** Service-role client — bypasses RLS. Use for reads/writes that need
   *  unrestricted table access (e.g. fetching price catalogues, writing
   *  profile rows). */
  admin: SupabaseClient
  /** User-JWT client — sees RLS as the signed-in admin. Required for RPCs
   *  that check auth.uid() / is_admin() internally, since service-role has
   *  no user context and those checks would fail. */
  user: SupabaseClient
  callerId: string
  /** Caller's email + display label, ready to pass into audit log inserts. */
  callerEmail: string
  callerLabel: string
}

/**
 * Validate the Authorization header, check the caller is an active admin,
 * and return a service-role client plus the caller's user id.
 * Returns a Response to send back immediately on any failure.
 */
export async function requireAdmin(req: Request): Promise<CallerContext | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'Unauthorized' }, 401)
  }
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()

  const anon = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  )
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: profile } = await admin
    .from('profiles')
    .select('role, deactivated_at, full_name')
    .eq('id', userData.user.id)
    .single()
  if (profile?.role !== 'admin' || profile?.deactivated_at) {
    return json({ error: 'Forbidden' }, 403)
  }

  const user = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  )

  const callerEmail = userData.user.email ?? ''
  const callerLabel = (profile?.full_name as string | null) ?? callerEmail

  return { admin, user, callerId: userData.user.id, callerEmail, callerLabel }
}
