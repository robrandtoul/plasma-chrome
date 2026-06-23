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

// List the files under a Dropbox shared-link folder.
//
// IMPORTANT: Dropbox's files/list_folder only supports NON-recursive listing
// when reading through a shared_link ("Only non-recursive mode is supported for
// shared link" — https://www.dropbox.com/developers). Passing recursive:true
// together with shared_link makes the call fail, which previously left the file
// tally at zero even for folders that clearly had artwork in them. So we list
// each level non-recursively and walk subfolders ourselves via the shared_link
// + path form (path is relative to the shared-link root), with depth + entry
// caps so a deep/large tree can't run away, and following has_more pagination.
// Returns one entry per item; folder entries are flagged so the caller can
// exclude them from the file count.
export async function listSharedLinkEntries(
  token: string,
  url: string,
): Promise<{ name: string; is_folder: boolean; path: string }[]> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const out: { name: string; is_folder: boolean; path: string }[] = []
  const MAX_ENTRIES = 2000
  const MAX_DEPTH = 4

  // One level, following pagination. `path` is relative to the shared-link
  // root: '' is the folder the link points at, '/Sub' is a child folder.
  async function listLevel(path: string): Promise<{ name: string; isFolder: boolean }[]> {
    const level: { name: string; isFolder: boolean }[] = []
    let res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, shared_link: { url }, recursive: false }),
    })
    while (res.ok) {
      const page = await res.json().catch(() => null)
      const entries = Array.isArray(page?.entries) ? page.entries : []
      for (const e of entries) {
        level.push({ name: (e.name as string) ?? '', isFolder: e['.tag'] === 'folder' })
      }
      if (!page?.has_more || !page?.cursor) break
      res = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor: page.cursor }),
      })
    }
    return level
  }

  async function walk(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
    for (const e of await listLevel(path)) {
      if (out.length >= MAX_ENTRIES) break
      const childPath = `${path}/${e.name}`
      out.push({ name: e.name, is_folder: e.isFolder, path: childPath })
      if (e.isFolder) await walk(childPath, depth + 1)
    }
  }

  await walk('', 0)
  return out
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
