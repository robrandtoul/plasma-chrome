// Dropbox connection helper. The single-row proofs.dropbox_connection holds the
// app key/secret + the long-lived refresh token (token_access_type=offline);
// this refreshes the short-lived access token on demand and caches it back.
// Mirrors _shared/xero.ts getAccessContext. Uses a service-role client (the
// connection table is service-role only).

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'

// Return a valid Dropbox access token, refreshing (and caching) when the cached
// one is missing or within 60s of expiry. Null when Dropbox isn't connected.
export async function getDropboxAccessToken(admin: SupabaseClient): Promise<string | null> {
  const { data: conn } = await admin.from('dropbox_connection').select('*').eq('id', 1).single()
  if (!conn?.refresh_token) return null

  const stillValid =
    conn.access_token &&
    conn.access_token_expires_at &&
    new Date(conn.access_token_expires_at).getTime() - 60_000 > Date.now()
  if (stillValid) return conn.access_token as string

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token as string,
      client_id: conn.app_key as string,
      client_secret: conn.app_secret as string,
    }).toString(),
  })
  if (!res.ok) return null
  const tok = await res.json().catch(() => null)
  const access = tok?.access_token as string | undefined
  if (!access) return null

  await admin
    .from('dropbox_connection')
    .update({
      access_token: access,
      access_token_expires_at: new Date(Date.now() + ((tok.expires_in as number | undefined) ?? 14400) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  return access
}

// Parse an order folder name into its number + project. Folders are named
// "Order <number> - <project>" (e.g. "Order 403792 - Glosfume") — which is also
// exactly the Help Scout subject Stock Control keys on, so the number is read
// from the leading digits and the project is the rest. The "Order " prefix is
// optional and a bare "<number> - <project>" is still accepted; falls back to a
// null number + the whole name as the project.
export function parseOrderFolderName(name: string): { order_number: string | null; project_name: string } {
  const cleaned = name.replace(/^\s*order\s+/i, '')
  const m = cleaned.match(/^\s*(\d{3,})\s*[-–—]\s*(.+?)\s*$/)
  if (m) return { order_number: m[1], project_name: m[2].trim() }
  return { order_number: null, project_name: cleaned.trim() }
}
