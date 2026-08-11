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
): Promise<{ name: string; is_folder: boolean; path: string; size: number }[]> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const out: { name: string; is_folder: boolean; path: string; size: number }[] = []
  const MAX_ENTRIES = 2000
  const MAX_DEPTH = 4

  // One level, following pagination. `path` is relative to the shared-link
  // root: '' is the folder the link points at, '/Sub' is a child folder.
  async function listLevel(path: string): Promise<{ name: string; isFolder: boolean; size: number }[]> {
    const level: { name: string; isFolder: boolean; size: number }[] = []
    let res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, shared_link: { url }, recursive: false }),
    })
    while (res.ok) {
      const page = await res.json().catch(() => null)
      const entries = Array.isArray(page?.entries) ? page.entries : []
      for (const e of entries) {
        level.push({
          name: (e.name as string) ?? '',
          isFolder: e['.tag'] === 'folder',
          size: typeof e.size === 'number' ? e.size : 0,
        })
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
      out.push({ name: e.name, is_folder: e.isFolder, path: childPath, size: e.size })
      if (e.isFolder) await walk(childPath, depth + 1)
    }
  }

  await walk('', 0)
  return out
}

// Download one file's bytes from a shared-link folder via the content endpoint.
// `path` is relative to the shared-link root (e.g. "/Proof01.pdf"), exactly as
// returned by listSharedLinkEntries. Returns null on any failure so callers can
// stay best-effort.
export async function downloadSharedLinkFile(
  token: string,
  url: string,
  path: string,
): Promise<Uint8Array | null> {
  // The Dropbox-API-Arg header must be ASCII — escape any non-ASCII (unicode
  // filenames) as \uXXXX or Dropbox rejects the request.
  let arg = ''
  for (const ch of JSON.stringify({ url, path })) {
    const code = ch.charCodeAt(0)
    arg += code > 0x7e ? '\\u' + code.toString(16).padStart(4, '0') : ch
  }
  const res = await fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': arg },
  })
  if (!res.ok) return null
  const buf = await res.arrayBuffer().catch(() => null)
  return buf ? new Uint8Array(buf) : null
}

// ── Reading a folder by PATH ────────────────────────────────────────────────
//
// The shared-link helpers above serve the Orders page, where a designer pastes
// a link to a folder they just made. Reusing archived artwork needs the other
// route, because an ARCHIVED order folder has never been shared — three checked
// at random from 2008, 2013 and 2017 had no link at all — and making one would
// publish a decade of customers' artwork on permanent, public, downloadable
// URLs. Reading by path needs no link and publishes nothing.
//
// Path listing is also simply better where it applies: Dropbox allows
// recursive:true here, which the shared-link form forbids, so one call replaces
// the level-by-level walk above.

export interface FolderListing {
  /** Path of the folder itself, as Dropbox knows it. */
  folderPath: string
  folderName: string
  /** Entries with paths RELATIVE to the folder, e.g. "/JPGs/Proof01.jpg". */
  entries: { name: string; path: string; is_folder: boolean; size: number }[]
}

const MAX_ENTRIES = 2000

/**
 * List a folder and everything under it. Null when the path does not exist.
 *
 * ⚠ Tries the path as given, then under each top-level folder. This is not
 * belt-and-braces — it is the difference between working and not. Plasma's
 * Dropbox is a team space, so the account's real path to an order folder is
 * `/Rob Randtoul/Orders/Order 38294 - Norwood`, while the address bar a
 * designer copies from shows `/Orders/Order 38294 - Norwood`. The member folder
 * is simply absent from what they can see and paste, so the obvious
 * implementation 404s on every hand-pasted URL while looking perfectly correct.
 */
export async function listFolderByPath(token: string, path: string): Promise<FolderListing | null> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const open = async (p: string): Promise<Response | null> => {
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: p, recursive: true, limit: 500 }),
    })
    return r.ok ? r : null
  }

  let res = await open(path)
  if (!res) {
    // Prepend each top-level folder in turn. Bounded by however many the
    // account has (a handful), and stops at the first that opens.
    const rootRes = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '', recursive: false, limit: 200 }),
    })
    const root = rootRes.ok ? await rootRes.json().catch(() => null) : null
    for (const e of Array.isArray(root?.entries) ? root.entries : []) {
      if (e['.tag'] !== 'folder' || typeof e.path_display !== 'string') continue
      const candidate = `${e.path_display}${path}`
      res = await open(candidate)
      if (res) {
        path = candidate
        break
      }
    }
  }
  if (!res) return null

  const entries: FolderListing['entries'] = []

  // The folder's own path as Dropbox spells it — case and namespace may differ
  // from what was pasted, and the relative paths below are cut from it.
  const prefix = path.replace(/\/+$/, '')
  const prefixLower = prefix.toLowerCase()

  while (res.ok) {
    const page = await res.json().catch(() => null)
    for (const e of Array.isArray(page?.entries) ? page.entries : []) {
      const full = (e.path_display as string | undefined) ?? ''
      const rel = full.toLowerCase().startsWith(prefixLower) ? full.slice(prefix.length) : full
      entries.push({
        name: (e.name as string) ?? '',
        path: rel || `/${e.name}`,
        is_folder: e['.tag'] === 'folder',
        size: typeof e.size === 'number' ? e.size : 0,
      })
      if (entries.length >= MAX_ENTRIES) break
    }
    if (entries.length >= MAX_ENTRIES || !page?.has_more || !page?.cursor) break
    res = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST',
      headers,
      body: JSON.stringify({ cursor: page.cursor }),
    })
  }

  return { folderPath: prefix, folderName: prefix.split('/').filter(Boolean).pop() ?? prefix, entries }
}

/**
 * Find a folder by name. Used only when the designer supplied a bare name
 * rather than a link or a path.
 *
 * ⚠ Returns a path only when exactly ONE folder matches. Order folders are
 * named "Order <number> - <customer>", and the number makes a full name
 * unique — but a partial one ("Norwood") can match several years of that
 * customer's work, and picking the first would hand back a different job's
 * artwork with nothing on screen to say so.
 */
export async function findFolderByName(token: string, name: string): Promise<string | null> {
  const res = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: name,
      options: { filename_only: true, file_status: 'active', max_results: 25 },
    }),
  })
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  const matches: string[] = []
  for (const m of Array.isArray(body?.matches) ? body.matches : []) {
    const md = m?.metadata?.metadata
    if (md?.['.tag'] === 'folder' && typeof md.path_display === 'string') matches.push(md.path_display)
  }
  const exact = matches.filter((p) => (p.split('/').pop() ?? '').toLowerCase() === name.trim().toLowerCase())
  if (exact.length === 1) return exact[0]
  return matches.length === 1 ? matches[0] : null
}

/**
 * A direct, time-limited URL for one file's bytes.
 *
 * These are served with `access-control-allow-origin: *`, so the browser
 * fetches the artwork straight from Dropbox — verified against a real order
 * file. That keeps megabytes of JPEG out of this function entirely, and means
 * the cropping happens where the crop engine already lives.
 */
export async function getTemporaryLink(token: string, path: string): Promise<string | null> {
  const res = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  return typeof body?.link === 'string' ? body.link : null
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
